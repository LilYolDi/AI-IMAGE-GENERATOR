
require("dotenv").config();

const express = require("express");
const multer = require("multer");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const MODEL = "@cf/black-forest-labs/flux-2-klein-4b";

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

async function runCloudflare(form) {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${MODEL}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`
    },
    body: form
  });

  const contentType = response.headers.get("content-type") || "";

  if (!response.ok) {
    const errorText = await response.text();
    let message = errorText;

    try {
      const errorData = JSON.parse(errorText);
      message =
        errorData.errors?.map(item => item.message).join("; ") ||
        errorData.error?.message ||
        errorText;
    } catch {}

    throw new Error(`Cloudflare (${response.status}): ${message}`);
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

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Генерация изображений
app.post("/api/generate", async (req, res) => {
  try {
    if (!checkConfig(res)) return;

    const { prompt, size } = req.body || {};

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({
        error: "Напиши описание изображения."
      });
    }

    const [width, height] = getDimensions(size);

    const form = new FormData();

    form.append("prompt", prompt.trim());
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

// Редактирование изображений
app.post("/api/edit", upload.single("image"), async (req, res) => {
  try {
    if (!checkConfig(res)) return;

    const prompt = req.body.prompt;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({
        error: "Напиши, что изменить."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "Изображение не загружено."
      });
    }

    const form = new FormData();

    form.append("prompt", prompt.trim());
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

app.use((error, req, res, next) => {
  console.error(error);

  res.status(400).json({
    error: error.message || "Ошибка запроса."
  });
});

app.listen(PORT, () => {
  console.log(`AI IMAGE GENERATOR running on port ${PORT}`);
});
