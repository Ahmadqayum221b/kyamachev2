/**
 * Kimi K2.5 API integration — async content classification
 * API is OpenAI-compatible: https://platform.moonshot.cn/docs
 */

const KIMI_API = 'https://api.moonshot.cn/v1/chat/completions';
const MODEL    = 'moonshot-v1-8k';  // or 'moonshot-v1-32k' for longer content

const SYSTEM_PROMPT = `You are a knowledge classification assistant.
Given a piece of content (text, URL, note, or file description), return ONLY valid JSON with:
{
  "summary": "1-2 sentence summary",
  "labels":  ["label1", "label2"],   // 2-5 short tags, lowercase, singular
  "content_type": "text|url|image|document|code|recipe|quote|task|idea",
  "language": "en",
  "sentiment": "neutral|positive|negative",
  "topics": ["topic1"],
  "entities": ["named entities if any"],
  "reading_time_seconds": 30
}
No prose, no markdown fences. Raw JSON only.`;

/**
 * Classify content with Kimi AI
 * @param {string} content - the raw captured content
 * @param {string} apiKey  - Kimi API key
 * @returns {{ summary, labels, content_type, language, sentiment, topics, entities, reading_time_seconds }}
 */
export async function classifyWithKimi(content, apiKey) {
  const truncated = content.slice(0, 8000); // stay within 8k context

  const res = await fetch(KIMI_API, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model:       MODEL,
      max_tokens:  512,
      temperature: 0.1,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: `Classify this content:\n\n${truncated}` },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Kimi API error ${res.status}: ${err}`);
  }

  const data  = await res.json();
  const text  = data.choices?.[0]?.message?.content ?? '{}';

  // Strip any accidental markdown fences
  const clean = text.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(clean);
  } catch {
    // Fallback: return minimal structure so the entry still gets updated
    console.error('[kimi] JSON parse failed, raw:', text);
    return {
      summary:              text.slice(0, 200),
      labels:               [],
      content_type:         'text',
      language:             'en',
      sentiment:            'neutral',
      topics:               [],
      entities:             [],
      reading_time_seconds: Math.ceil(content.split(/\s+/).length / 200) * 60,
    };
  }
}
