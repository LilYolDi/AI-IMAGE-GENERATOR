require("dotenv").config();

const express = require("express");
const multer = require("multer");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.OPENAI_API_KEY;
const IMAGE_MODEL = process.env.IMAGE_MODEL || "gpt-image-1";

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/png", "image/jpeg", "image/webp"];

    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Поддерживаются PNG, JPEG и WEBP."));
    }

    cb(null, true);
  }
});

function checkApiKey(res) {
  if (!API_KEY) {
    res.status(500).json({
      error: "На сервере не указан OPENAI_API_KEY."
    });
    return false;
  }

  return true;
}

function getErrorMessage(data) {
  return data?.error?.message || "Ошибка при обращении к сервису генерации.";
}

// Генерация нового изображения
app.post("/api/generate", async (req, res) => {
  try {
    if (!checkApiKey(res)) return;

    const { prompt, size, quality } = req.body || {};

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({
        error: "Напиши описание изображения."
      });
    }

    const response = await fetch(
      "https://api.openai.com/v1/images/generations",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: IMAGE_MODEL,
          prompt: prompt.trim(),
          size: ["1024x1024", "1536x1024", "1024x1536"].includes(size)
            ? size
            : "1024x1024",
          quality: ["low", "medium", "high"].includes(quality)
            ? quality
            : "medium"
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: getErrorMessage(data)
      });
    }

    const image = data?.data?.[0]?.b64_json;

    if (!image) {
      return res.status(500).json({
        error: "Сервис не вернул изображение."
      });
    }

    res.json({
      image: `data:image/png;base64,${image}`
    });

  } catch (error) {
    console.error("Generation error:", error);

    res.status(500).json({
      error: "Не удалось создать изображение."
    });
  }
});

// Редактирование существующего изображения
app.post("/api/edit", upload.single("image"), async (req, res) => {
  try {
    if (!checkApiKey(res)) return;

    const prompt = req.body.prompt;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({
        error: "Напиши, что нужно изменить."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "Изображение для редактирования не загружено."
      });
    }

    const form = new FormData();

    form.append("model", IMAGE_MODEL);
    form.append("prompt", prompt.trim());
    form.append("size", "1024x1024");
    form.append("quality", "medium");

    const imageBlob = new Blob(
      [req.file.buffer],
      { type: req.file.mimetype }
    );

    form.append("image", imageBlob, req.file.originalname || "image.png");

    const response = await fetch(
      "https://api.openai.com/v1/images/edits",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`
        },
        body: form
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: getErrorMessage(data)
      });
    }

    const image = data?.data?.[0]?.b64_json;

    if (!image) {
      return res.status(500).json({
        error: "Сервис не вернул отредактированное изображение."
      });
    }

    res.json({
      image: `data:image/png;base64,${image}`
    });

  } catch (error) {
    console.error("Edit error:", error);

    res.status(500).json({
      error: "Не удалось отредактировать изображение."
    });
  }
});

// Обработка ошибок загрузки
app.use((error, req, res, next) => {
  console.error(error);

  res.status(400).json({
    error: error.message || "Ошибка запроса."
  });
});

app.listen(PORT, () => {
  console.log(`AI IMAGE GENERATOR running on port ${PORT}`);
});