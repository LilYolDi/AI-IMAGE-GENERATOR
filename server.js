
require("dotenv").config();

const express = require("express");
const multer = require("multer");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

const IMAGE_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const PROMPT_MODEL =
  process.env.CLOUDFLARE_PROMPT_MODEL || "@cf/qwen/qwen3.8-27b";

app.use(express.json({ limit: "10mb" }));
app.use(express.static(__dirname));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = ["image/png", "image/jpeg", "image/webp"];

    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Поддерживаются PNG, JPEG и WEBP."));
    }

    cb(null, true);
  }
});

function checkConfig(res) {
  if (!ACCOUNT_ID || !API_TOKEN) {
    res.status(500).json({
      error: "Не настроены CLOUDFLARE_ACCOUNT_ID и CLOUDFLARE_API_TOKEN на Render."
    });
    return false;
  }

  return true;
}

function cloudflareUrl(model) {
  return `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${model}`;
}

async function readCloudflareError(response) {
  const text = await response.text();

  try {
    const data = JSON.parse(text);

    return (
      data.errors?.map(item => item.message).join("; ") ||
      data.error?.message ||
      text
    );
  } catch {
    return text;
  }
}

// ---------- ИИ-обработка запросов ----------

async function improvePrompt(originalPrompt, mode = "generate") {
  const editing = mode === "edit";

  const systemPrompt = editing
    ? `
You are a professional AI image editing prompt engineer.

Convert the user's Russian editing instruction into a precise, natural English instruction for FLUX.2 Klein.

STRICT RULES:
- Preserve the exact meaning of the user's request.
- Change ONLY the elements the user explicitly asks to change.
- Preserve everything else in the original image.
- Do not change faces, identity, age, gender, hairstyle, clothing, pose, background, objects or composition unless explicitly requested.
- Do not invent additional objects, people or details.
- Do not turn an editing request into a completely new image.
- Use clear, direct English.
- Output ONLY the final editing instruction.
`
    : `
You are a professional image prompt engineer specializing in FLUX.2 Klein.

Convert the user's Russian description into a precise, detailed English image generation prompt.

YOUR MAIN GOAL:
Make the generated image match the user's description as closely as possible.

STRICT RULES:
1. Preserve every important detail from the original request.
2. Never change the requested subject, number of people, gender, age, appearance or identity.
3. Preserve requested clothing, colors, hairstyle, facial features and accessories.
4. Preserve the requested pose, actions, body position and interactions.
5. Preserve the location, background, objects and environment.
6. Preserve the requested camera angle, framing, lighting, atmosphere and visual style.
7. Never add people, objects, animals or other elements that the user did not request.
8. Do not replace specific details with generic descriptions.
9. Do not contradict any part of the original request.
10. If something is not specified, do not invent unnecessary details.
11. Use natural, clear and precise English suitable for FLUX.2.
12. Describe the scene as one coherent image, not as a story.

IMPORTANT:
The original user description is the source of truth.
Your job is to translate and clarify it, NOT creatively reinterpret it.

Return ONLY the final English image prompt.
Do not include explanations, headings, quotation marks or comments.
`;

  const response = await fetch(cloudflareUrl(PROMPT_MODEL), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: originalPrompt.trim()
        }
      ],
      max_completion_tokens: 700,
      temperature: 0.2,
      reasoning_effort: "low"
    })
  });

  if (!response.ok) {
    const error = await readCloudflareError(response);

    throw new Error(
      `Ошибка ИИ-обработки запроса (${response.status}): ${error}`
    );
  }

  const data = await response.json();

  let improved =
    data.result?.response ||
    data.result?.choices?.[0]?.message?.content ||
    data.choices?.[0]?.message?.content;

  if (typeof improved !== "string" || !improved.trim()) {
    throw new Error("ИИ не смог подготовить описание изображения.");
  }

  improved = improved
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:text)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  if (!improved) {
    throw new Error("Получено пустое описание после обработки.");
  }

  console.log("Original prompt:", originalPrompt);
  console.log("Improved prompt:", improved);

  return improved;
}

// ---------- Генерация изображения ----------

async function runCloudflare(form) {
  const response = await fetch(cloudflareUrl(IMAGE_MODEL), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`
    },
    body: form
  });

  const contentType = response.headers.get("content-type") || "";

  if (!response.ok) {
    const error = await readCloudflareError(response);
    throw new Error(`Cloudflare (${response.status}): ${error}`);
  }

  if (contentType.includes("application/json")) {
    const data = await response.json();

    const image =
      data.result?.image ||
      data.result ||
      data.image;

    if (typeof image === "string") {
      return image.startsWith("data:image/")
        ? image
        : `data:image/png;base64,${image}`;
    }

    throw new Error("Cloudflare не вернул изображение.");
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (!buffer.length) {
    throw new Error("Получено пустое изображение.");
  }

  const mime = contentType.includes("jpeg")
    ? "image/jpeg"
    : "image/png";

  return `data:${mime};base64,${buffer.toString("base64")}`;
}

function getDimensions(size) {
  const sizes = {
    "1024x1024": [1024, 1024],
    "1536x1024": [1536, 1024],
    "1024x1536": [1024, 1536]
  };

  return sizes[size] || sizes["1024x1024"];
}

// ---------- Главная ----------

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ---------- Генерация ----------

app.post("/api/generate", async (req, res) => {
  try {
    if (!checkConfig(res)) return;

    const { prompt, size } = req.body || {};

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({
        error: "Напиши описание изображения."
      });
    }

    if (prompt.length > 6000) {
      return res.status(400).json({
        error: "Описание слишком длинное. Максимум 6000 символов."
      });
    }

    console.log("Preparing generation prompt...");

    const improvedPrompt = await improvePrompt(prompt, "generate");

    const [width, height] = getDimensions(size);

    const form = new FormData();

    form.append("prompt", improvedPrompt);
    form.append("width", String(width));
    form.append("height", String(height));

    const image = await runCloudflare(form);

    res.json({ image });

  } catch (error) {
    console.error("Generation error:", error);

    res.status(500).json({
      error: error.message || "Не удалось создать изображение."
    });
  }
});

// ---------- Редактирование ----------

app.post("/api/edit", upload.single("image"), async (req, res) => {
  try {
    if (!checkConfig(res)) return;

    const prompt = req.body.prompt;

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({
        error: "Напиши, что изменить."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "Изображение не загружено."
      });
    }

    if (prompt.length > 6000) {
      return res.status(400).json({
        error: "Описание слишком длинное. Максимум 6000 символов."
      });
    }

    console.log("Preparing editing prompt...");

    const improvedPrompt = await improvePrompt(prompt, "edit");

    const form = new FormData();

    form.append("prompt", improvedPrompt);
    form.append("width", "1024");
    form.append("height", "1024");

    form.append(
      "input_image_0",
      new Blob([req.file.buffer], {
        type: req.file.mimetype
      }),
      req.file.originalname || "image.png"
    );

    const image = await runCloudflare(form);

    res.json({ image });

  } catch (error) {
    console.error("Edit error:", error);

    res.status(500).json({
      error: error.message || "Не удалось отредактировать изображение."
    });
  }
});

// ---------- Ошибки ----------

app.use((error, req, res, next) => {
  console.error(error);

  res.status(400).json({
    error: error.message || "Ошибка запроса."
  });
});

// ---------- Запуск ----------

app.listen(PORT, () => {
  console.log("AI IMAGE GENERATOR running on port " + PORT);
  console.log("Image model:", IMAGE_MODEL);
  console.log("Prompt model:", PROMPT_MODEL);
});
