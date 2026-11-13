
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

// ---------- Подготовка референса ----------

async function prepareReference(file) {
  if (!file) return null;

  let sharp;

  try {
    sharp = require("sharp");
  } catch {
    throw new Error(
      "Для обработки фото-образца нужен пакет sharp. Проверьте package.json."
    );
  }

  const buffer = await sharp(file.buffer)
    .rotate()
    .resize({
      width: 511,
      height: 511,
      fit: "inside",
      withoutEnlargement: true
    })
    .jpeg({ quality: 90 })
    .toBuffer();

  return buffer;
}

// ---------- Обязательные требования пользователя ----------

function addExplicitConstraints(originalPrompt, improvedPrompt) {
  const prompt = originalPrompt.toLowerCase().replace(/ё/g, "е");

  const constraints = [];

  const asksForSocks =
    /нос(ок|ки|ков|ках|кам|очк|очек)/i.test(prompt);

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

  const asksForFeet =
    /(ступн|стоп|ноги|ногах|ногами|пальц\w+\s+ног)/i.test(prompt);

  const asksForLegs =
    /(ноги|ногах|ногами|бедр|икр|голен)/i.test(prompt);

  const asksForFullBody =
    /(полный\s+рост|во\s+весь\s+рост|целиком|с\s+головы\s+до\s+ног|в\s+полный\s+рост)/i.test(prompt);

  const asksForPose =
    /(поз[ауы]|позу|позиц|стоять|стоит|стоя|сидеть|сидит|сидя|лежать|лежит|лежа|на\s+коленях|на\s+четвереньках|повернут|повернуться|наклонить|наклониться|поднять\s+рук|опустить\s+рук|скрестить|развернут|развернуться)/i.test(prompt);

  const asksForCamera =
    /(ракурс|вид\s+сверху|вид\s+снизу|сбоку|спереди|сзади|камера|точка\s+съемки)/i.test(prompt);

  if (asksForPose) {
    constraints.push(
      "IMPORTANT: Follow the exact pose and body position requested by the user. If a different pose is requested, change the reference pose. NEVER preserve the original pose against the user's instructions."
    );
  }

  if (asksForFullBody) {
    constraints.push(
      "Show the entire person from head to feet. Use full-body framing. Do not crop the head, legs, feet or any part of the body."
    );
  }

  if (asksForFeet) {
    constraints.push(
      "The requested feet and toes must be clearly visible in the image. Keep both feet inside the frame when both are requested. Do not hide them behind objects, furniture, clothing or another body part. Do not crop them."
    );
  }

  if (asksForLegs) {
    constraints.push(
      "The requested legs must be clearly visible. Include the necessary lower-body area in the frame. Do not crop or hide the legs."
    );
  }

  if (asksForCamera) {
    constraints.push(
      "Follow the exact camera angle and viewing direction requested by the user, even if it differs from the reference image."
    );
  }

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

    constraints.push(
      "The socks must be clean, intact, solid fabric, with no holes, tears, rips, fraying or damage."
    );
  }

  if (asksForNoShoes) {
    constraints.push(
      "NO SHOES AT ALL. No boots, sneakers, heels, sandals, slippers or other footwear."
    );

    if (asksForSocks && !asksForNoSocks) {
      constraints.push(
        "Keep the requested socks ON BOTH FEET. Do NOT show bare feet. No footwear, but socks are REQUIRED."
      );
    } else {
      constraints.push(
        "Do not add footwear. Follow the user's exact instructions about socks and feet."
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

  const result =
    improvedPrompt.trim() +
    "\n\nMANDATORY USER REQUIREMENTS:\n" +
    constraints.map((item, index) => `${index + 1}. ${item}`).join("\n");

  console.log("Explicit constraints:", constraints);

  return result;
}

// ---------- ИИ-обработка запросов ----------

async function improvePrompt(originalPrompt, mode = "generate") {
  const editing = mode === "edit";
  const hasReference = mode === "generate-reference";

  const commonRules = `
GENERAL RULES:
- Preserve the user's exact meaning and all important details.
- Do not shorten the description by removing important requirements.
- Do not replace specific details with vague descriptions.
- Do not invent unrequested people, objects, clothing or accessories.
- Understand negative instructions correctly.
- Shoes, socks, trousers and other clothing items are independent.
- Removing shoes does NOT mean removing socks.
- If the user requests socks without shoes, keep socks on the feet and remove footwear only.
- Follow requested colors, clothing types, lengths and materials precisely.
- For mature or sensual themes, all depicted people must be clearly adults.
- Never turn an adult character into a minor.
- Output ONLY the final English image prompt.
- Do not include explanations or comments.
`;

  let systemPrompt;

  if (editing) {
    systemPrompt = `
You are a professional AI image editing prompt engineer specializing in FLUX.2 Klein.

Convert the user's Russian editing instruction into a precise English image editing prompt.

EDITING RULES:
1. Change ONLY the elements explicitly requested by the user.
2. Preserve the original identity and recognizable appearance of the person.
3. Preserve the original face, hairstyle, clothing, accessories, background, lighting and composition unless the user requests a change.
4. If the user requests a different pose, change the pose. Do not preserve the original pose against the user's instruction.
5. If the user requests a different camera angle, follow the requested camera angle.
6. If the user requests full-body framing, show the entire person from head to feet.
7. If the user requests visible feet or legs, make sure they are inside the frame and not hidden or cropped.
8. Do not change unrelated details.
9. Do not add extra people or objects.

${commonRules}
`;
  } else if (hasReference) {
    systemPrompt = `
You are a professional image generation prompt engineer specializing in FLUX.2 Klein.

The user has attached a reference image.

Convert the user's Russian description into a precise, detailed English image generation prompt.

REFERENCE IMAGE RULES:
1. Use the attached image as the primary visual reference for the person's appearance and the scene.
2. Preserve the person's recognizable face, appearance, hairstyle and other visual characteristics unless the user requests changes.
3. Preserve clothing, colors and accessories unless the user requests changes.
4. Preserve the background, environment and lighting unless the user requests changes.
5. Preserve the original composition and camera angle ONLY when the user has not requested a different composition or angle.
6. Preserve the original pose ONLY when the user has not requested a different pose.
7. If the user describes a new pose, the requested pose MUST replace the reference pose.
8. If the user requests standing, sitting, lying down, kneeling or another specific position, follow that position precisely.
9. If the user requests full-body framing, show the entire person from head to feet.
10. If the user requests visible feet, legs or another body part, make that area clearly visible and keep it inside the frame.
11. Do not hide requested body parts behind objects, furniture, clothing or other body parts.
12. Do not crop requested body parts.
13. If the user requests a different camera angle or viewing direction, follow the user's instruction instead of the reference.
14. Change only the details requested by the user. Preserve all unrelated reference details.
15. Do not add unrequested people, objects or scene elements.
16. Never let the reference image override the user's explicit instructions.

PRIORITY ORDER:
1. The user's explicit text instructions.
2. The reference image for all details the user did not ask to change.

${commonRules}
`;
  } else {
    systemPrompt = `
You are a professional image generation prompt engineer specializing in FLUX.2 Klein.

Convert the user's Russian description into a precise and detailed English image generation prompt.

GENERATION RULES:
1. Preserve every important detail in the user's description.
2. Follow the requested subject, number of people, appearance and adult age.
3. Follow the requested clothing, colors, hairstyle and accessories.
4. Follow the exact requested pose and body position.
5. Follow the requested actions and interactions.
6. Follow the requested background and environment.
7. Follow the requested camera angle, perspective and framing.
8. If full-body framing is requested, show the entire person from head to feet.
9. If feet or legs are requested to be visible, keep them clearly visible and inside the frame.
10. Do not hide or crop body parts that the user specifically asks to show.
11. Never add unrequested people or objects.
12. Do not replace specific details with generic descriptions.
13. Removing one clothing item NEVER means removing another clothing item.
14. Shoes, socks, trousers and other clothing are separate items.
15. If the user requests a specific color, length or type of clothing, preserve it exactly.
16. If something is not specified, do not invent unnecessary details.

${commonRules}
`;
  }

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
      max_completion_tokens: 900,
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

// ---------- Генерация с необязательным фото-образцом ----------

app.post("/api/generate", upload.single("reference"), async (req, res) => {
  try {
    if (!checkConfig(res)) return;

    const { prompt, size } = req.body || {};
    const referenceFile = req.file || null;

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

    console.log(
      referenceFile
        ? "Preparing generation with reference image..."
        : "Preparing generation prompt..."
    );

    const improvedPrompt = await improvePrompt(
      prompt,
      referenceFile ? "generate-reference" : "generate"
    );

    const [width, height] = getDimensions(size);

    const form = new FormData();

    form.append("prompt", improvedPrompt);
    form.append("width", String(width));
    form.append("height", String(height));

    if (referenceFile) {
      const referenceBuffer = await prepareReference(referenceFile);

      form.append(
        "input_image_0",
        new Blob([referenceBuffer], {
          type: "image/jpeg"
        }),
        "reference.jpg"
      );

      console.log("Reference image attached to FLUX request.");
    }

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
