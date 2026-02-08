const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

app.post("/webhook", async (req, res) => {
  const entry = req.body.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const comment = value?.comment;

  if (!comment) {
    return res.sendStatus(200);
  }

  const commentId = comment.id;
  const message = comment.message;

  const replyText = "Спасибо за комментарий 🙌";

  await fetch(`https://graph.facebook.com/v19.0/${commentId}/comments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: replyText,
      access_token: process.env.PAGE_TOKEN
    })
  });

  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("Bot is running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server started"));
