// api/chat.js — Vercel Serverless Function - FINAL
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const SYSTEM_PROMPT = `
Kamu adalah TRYHOUNDZUL, asisten AI cerdas buatan Zul (developer).
Gaya bicara: Gaul, santai, ramah, seperti teman nongkrong. Panggil user dengan "lu" atau "bro", dan pakai "gue" untuk diri sendiri. Selalu jawab dalam Bahasa Indonesia, kecuali user meminta bahasa lain. Jangan kaku, tapi tetap informatif dan akurat.
Keahlian: Coding, Deploy, Ide konten, belajar, dan topik umum.
Aturan: Kalau ditanya soal ngoding, kasih kode rapi di dalam code block plus penjelasan singkat. Pakai markdown: **bold**, \`inline code\`, \`\`\`code block\`\`\`, dan list jika perlu. Jawaban ringkas tapi lengkap.
Identitas: Nama TRYHOUNDZUL, Dibuat oleh Zul.
`.trim();

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_MSG = 4000;
const MAX_HISTORY = 16;
const TIMEOUT_MS = 25000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method tidak diizinkan. Pakai POST ya.' });
  }

  try {
    const { message, history } = req.body || {};

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Field "message" wajib diisi.' });
    }
    if (message.length > MAX_MSG) {
      return res.status(400).json({ error: `Pesan maksimal ${MAX_MSG} karakter.` });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GEMINI_API_KEY belum diset di Environment Variables Vercel.' });
    }

    let safeHistory = Array.isArray(history)
      ? history
          .filter((h) => h && (h.role === 'user' || h.role === 'model') && typeof h.text === 'string' && h.text.trim())
          .map((h) => ({ role: h.role, text: h.text.slice(0, MAX_MSG) }))
          .slice(-MAX_HISTORY)
      : [];

    while (safeHistory.length && safeHistory[0].role === 'model') safeHistory.shift();

    const raw = [
      ...safeHistory.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
      { role: 'user', parts: [{ text: message.trim() }] },
    ];
    const contents = [];
    for (const c of raw) {
      const last = contents[contents.length - 1];
      if (last && last.role === c.role) {
        last.parts[0].text += '\n\n' + c.parts[0].text;
      } else {
        contents.push(c);
      }
    }

    const payload = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      generationConfig: { temperature: 0.9, topP: 0.95, topK: 40, maxOutputTokens: 2048 },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
      ],
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let data;
    try {
      const response = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        console.error('[GEMINI ERROR]', response.status, await response.text());
        return res.status(502).json({ error: 'Gagal menghubungi Gemini API.' });
      }
      data = await response.json();
    } catch (err) {
      if (err?.name === 'AbortError') {
        console.error('[GEMINI TIMEOUT]');
        return res.status(504).json({ error: 'Gemini kelamaan jawab. Coba lagi ya.' });
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (data.promptFeedback?.blockReason) {
      console.warn('[PROMPT BLOCKED]', data.promptFeedback);
      return res.status(200).json({ reply: 'Hmm, pertanyaan lu agak sensitif bro. Coba tanya dengan cara lain ya.' });
    }

    const candidate = data?.candidates?.[0];
    if (!candidate) {
      console.warn('[NO CANDIDATE]', JSON.stringify(data).slice(0, 500));
      return res.status(200).json({ reply: 'Gue lagi diblokir safety filter nih. Coba tanya dengan cara yang lebih santai ya bro.' });
    }

    let reply = (candidate.content?.parts || [])
      .filter((p) => typeof p?.text === 'string' && p.text.trim() && !p.thought)
      .map((p) => p.text)
      .join('\n')
      .trim();

    if (candidate.finishReason && candidate.finishReason !== 'STOP') {
      console.log('[FINISH REASON]', candidate.finishReason);
    }

    if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'RECITATION') {
      reply = 'Jawabannya kena safety filter bro. Coba tanya dengan cara lain ya.';
    } else if (!reply) {
      reply = 'Hmm, gue belum bisa jawab itu bro. Coba tanya lagi ya.';
    } else if (candidate.finishReason === 'MAX_TOKENS') {
      reply += '\n\n_(jawaban kepotong, ketik "lanjut" ya bro)_';
    }

    return res.status(200).json({ reply });
  } catch (err) {
    console.error('[SERVER ERROR]', err);
    return res.status(500).json({ error: 'Terjadi kesalahan di server.' });
  }
}
