import sanitizeHtml from 'sanitize-html';

// The LLM owns semantics, the theme owns presentation: vanilla tags only,
// no class/style/id/on*, https-only URLs. Embeds are NOT allowed as iframes —
// the client builds those itself from <a data-embed href="<youtube url>">.
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'blockquote', 'strong', 'em', 'b', 'i', 'code', 'pre',
    'a', 'img', 'hr', 'br', 'div', 'span', 'figure', 'figcaption',
  ],
  allowedAttributes: {
    a: ['href', 'data-embed'],
    img: ['src', 'alt'],
  },
  allowedSchemes: ['https'],
  disallowedTagsMode: 'discard',
};

export function sanitizeDisplayHtml(raw: string): string {
  const clean = sanitizeHtml(raw, OPTIONS);
  // Rough drift signal for tuning the producer's LLM prompt: how many tags
  // did sanitization drop?
  const before = (raw.match(/<[a-zA-Z][^\s>/]*/g) ?? []).length;
  const after = (clean.match(/<[a-zA-Z][^\s>/]*/g) ?? []).length;
  if (before > after) {
    console.warn(`[sanitize] stripped ${before - after}/${before} tags from payload`);
  }
  return clean;
}
