import { marked } from 'marked';
import { sanitizeNoteHtml } from './sanitize';

export interface RenderedNote {
  /** Sanitized HTML — wikilinks are `<a data-note="…">` anchors. */
  html: string;
  /** Raw YAML frontmatter text, if the note had a leading block. */
  frontmatter?: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
// Group 1: target, group 2: optional |alias (heading fragments dropped).
const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;
// Fenced blocks and inline code, where [[…]] must stay literal.
const CODE_SPANS = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/;

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function linkifyWikilinks(markdown: string): string {
  return markdown
    .split(CODE_SPANS)
    .map((part, i) => {
      if (i % 2 === 1) return part; // inside code — leave untouched
      return part.replace(WIKILINK, (_match, target: string, alias?: string) => {
        const id = target.trim();
        const label = (alias ?? '').trim() || id;
        return `<a data-note="${escapeHtml(id)}">${escapeHtml(label)}</a>`;
      });
    })
    .join('');
}

/**
 * Vault markdown → sanitized HTML for the brain view's note panel.
 * Frontmatter is split out (marked would render `---` fences as rules), and
 * wikilinks become in-app note anchors before markdown parsing.
 */
export function renderNoteHtml(markdown: string): RenderedNote {
  const fmMatch = markdown.match(FRONTMATTER);
  const frontmatter = fmMatch?.[1].trim();
  const body = fmMatch ? markdown.slice(fmMatch[0].length) : markdown;
  const html = sanitizeNoteHtml(marked.parse(linkifyWikilinks(body), { async: false }));
  return { html, ...(frontmatter ? { frontmatter } : {}) };
}
