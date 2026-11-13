
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

// ---------- Точная проверка требований пользователя ----------

function addExplicitConstraints(originalPrompt, improvedPrompt) {
  const prompt = originalPrompt.toLowerCase().replace(/ё/g, "е");

  const constraints = [];

  const asksForSocks =
    /нос(ок|ки|ков|ках|кам|очк|очк[аиу]|очек)/i.test(prompt);

  const asksForBlackSocks =
    /(черн\w*.{0,35}нос|нос\w*.{0,35}черн)/i.test(prompt);

  const asksForShortSocks =
    /(коротк\w*.{0,35}нос|нос\w*.{0,35}коротк)/i.test(prompt);

  const asksForPants =
    /(брюк|штан|джинс|тренировочн\w+\s+штан)/i.test(prompt);

  const asksForNoShoes =
    /(без\s+(?:всякой\s+)?обув|не\s+обув|обувь\s+не|никак\w*\s+обув)/i.test(prompt);

  const asksForNoSocks =
    /(без\s+нос|не\s+надевать\s+нос|без\s+носк)/i.test(prompt);

  // Носки и обувь — независимые элементы одежды.
  if (asksForSocks && !asksForNoSocks) {
    constraints.push(
      "The person MUST wear socks. The socks must be clearly visible."
    );

    if (asksForBlackSocks) {
      constraints.push(
        "The socks MUST be black. Do not change their color."
      );
    }

    if (asksForShortSocks) {
      constraints.push(
        "The socks MUST be short ankle socks, not long socks or stockings."
      );
    }
  }

  // Отсутствие обуви не означает отсутствие носков.
  if (asksForNoShoes) {
    constraints.push(
      "NO SHOES AT ALL. No boots, no sneakers, no heels, no sandals, no slippers and no other footwear."
    );

    if (asksForSocks && !asksForNoSocks) {
      constraints.push(
        "IMPORTANT: Keep the requested socks ON BOTH FEET. The feet must remain covered by socks. Do NOT show bare feet. No footwear, but socks are REQUIRED."
      );
    } else {
      constraints.push(
        "Do not add any footwear. Follow the user's exact instructions about socks and feet."
      );
    }
  }

  if (asksForPants) {
    constraints.push(
      "The person MUST wear the requested pants or trousers. Do not replace them with a skirt, shorts or underwear."
    );
  }

  if (asksForNoSocks) {
    constraints.push(
      "Do not add socks or stockings. Follow the user's requested footwear independently."
    );
  }

  if (constraints.length === 0) {
    return improvedPrompt;
  }

  const result = improvedPrompt.trim() +
    "\n\nMANDATORY USER REQUIREMENTS:\n" +
    constraints.map((item, index) => `${index + 1}. ${item}`).join("\n");

  console.log("Explicit constraints:", constraints);

  return result;
}

// ---------- ИИ-обработка запросов ----------

async function improvePrompt(originalPrompt, mode = "generate") {
  const editing = mode === "edit";

  const systemPrompt = editing
    ? `
You are a professional AI image editing prompt engineer.

Convert the user's Russian editing instruction into precise English for FLUX.2 Klein.

STRICT RULES:
- Preserve the exact meaning of the user's request.
- Change ONLY elements explicitly requested.
- Preserve everything else in the original image.
- Clothing items are independent. Removing shoes does NOT mean removing socks.
- If the user requests socks without shoes, keep socks on the feet.
- Never confuse socks with bare feet.
- Do not change identity, face, age, gender, hairstyle, clothing, pose or background unless requested.
- Do not invent additional objects or people.
- Output ONLY the final English instruction.
`
    : `
You are a professional image prompt engineer specializing in FLUX.2 Klein.

Convert the user's Russian description into a precise English image generation prompt.

STRICT RULES:
1. Preserve every important detail.
2. Preserve the requested subject, number of people, gender and age.
3. Preserve appearance, clothing, colors, hairstyle and accessories.
4. Preserve pose, actions and body position.
5. Preserve background and environment.
6. Preserve camera angle, framing and lighting.
7. Never add unrequested people or objects.
8. Do not replace specific details with generic descriptions.
9. Understand negative instructions correctly.
10. Removing one clothing item NEVER means removing another clothing item.
11. Shoes, socks, trousers and other clothing are separate items.
12. "Without shoes but wearing socks" means socks remain ON the feet and NO shoes are present.
13. Never interpret "without shoes" as "barefoot" when socks are requested.
14. If the user requests a specific color or length of socks, preserve it exactly.
15. If something is not specified, do not invent unnecessary details.

The original user description is the source of truth.

Return ONLY the final English image prompt.
No explanations or comments.
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

  // Дополнительная проверка исходных требований.
  improved = addExplicitConstraints(originalPrompt, improved);

  console.log("Original prompt:", originalPrompt);
  console.log("Final prompt:", improved);

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
