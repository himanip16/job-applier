import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { normalizeCityName } from '@ja/shared';

/**
 * Pull plain text out of a resume so the model can read it.
 *
 * Everything the system claims about the candidate is grounded in this text,
 * so a bad extraction degrades every downstream answer. When extraction yields
 * suspiciously little, we say so rather than proceeding with a near-empty
 * context - a silent empty resume is how you end up with a cover letter full
 * of hedged generalities.
 */
export async function extractResumeText(filePath: string, mimeType: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();

  if (mimeType === 'application/pdf' || ext === '.pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const buf = await readFile(filePath);
    const pdf = await getDocumentProxy(new Uint8Array(buf));

    // Try with mergePages: true first (default behavior)
    let textResult = await extractText(pdf, { mergePages: true });
    let body = clean(Array.isArray(textResult.text) ? textResult.text.join('\n') : textResult.text);

    // If extraction looks suspicious (very short or many truncation patterns),
    // try with mergePages: false as a fallback for multi-column PDFs
    const assessment = assessResumeText(body);
    if (assessment.warning && assessment.warning.includes('suspiciously short tokens')) {
      const fallbackResult = await extractText(pdf, { mergePages: false });
      const fallbackBody = clean(Array.isArray(fallbackResult.text) ? fallbackResult.text.join('\n') : fallbackResult.text);
      // Use the longer extraction
      if (fallbackBody.length > body.length) {
        body = fallbackBody;
      }
    }

    // "LinkedIn" and "GitHub" on a resume are usually clickable words whose
    // addresses live only in the PDF's link annotations, not its text. Without
    // them the profile cannot be filled and the model never sees the links.
    const links = await pdfLinks(pdf).catch(() => [] as string[]);
    return links.length ? `${body}\nLinks: ${links.join(' ')}` : body;
  }

  if (ext === '.docx' || mimeType.includes('officedocument.wordprocessingml')) {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ path: filePath });
    return clean(value);
  }

  if (ext === '.txt' || ext === '.md' || mimeType.startsWith('text/')) {
    return clean(await readFile(filePath, 'utf8'));
  }

  throw new Error(
    `Cannot read text out of ${ext || mimeType}. Upload a PDF, DOCX or TXT resume.`,
  );
}

/** Every web link in the document, in order, once each. */
async function pdfLinks(pdf: {
  numPages: number;
  getPage(n: number): Promise<{ getAnnotations(): Promise<Array<{ url?: string }>> }>;
}): Promise<string[]> {
  const seen = new Set<string>();
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    for (const a of await page.getAnnotations()) {
      if (a.url && /^https?:\/\//i.test(a.url)) seen.add(a.url);
    }
  }
  return [...seen];
}

function clean(s: string): string {
  let cleaned = s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Merge orphaned tokens that may have been split across columns
  // Detect patterns like "Ban\ngalore" or "Kar\nataka" from multi-column PDFs
  cleaned = mergeColumnOrphans(cleaned);

  return cleaned;
}

/**
 * Merge tokens that were likely split across PDF columns.
 * Multi-column layouts often cause text like "Ban\ngalore" or "Kar\nataka".
 * This uses a simple heuristic: if a line ends with a short fragment (3-5 chars)
 * and the next line starts with a continuation that could complete a word,
 * merge them.
 */
function mergeColumnOrphans(text: string): string {
  const lines = text.split('\n');
  const merged: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const current = lines[i]!;
    const next = lines[i + 1];

    if (!next) {
      merged.push(current);
      continue;
    }

    // Check if current line ends with a short fragment (potential column break)
    const lastWord = current.trim().split(' ').pop() || '';
    const firstWord = next.trim().split(' ')[0] || '';

    // If last word is 3-5 chars and first word of next line could continue it
    if (lastWord.length >= 3 && lastWord.length <= 5 && firstWord.length >= 3) {
      const combined = lastWord + firstWord;
      // Check if combined is a known city name (common in resumes)
      const normalizedCombined = normalizeCityName(combined);
      if (normalizedCombined && normalizedCombined.toLowerCase() === combined.toLowerCase()) {
        // Merge the lines by joining without space
        const mergedLine = current.replace(/\S+$/, '') + combined + next.slice(firstWord.length);
        merged.push(mergedLine);
        continue;
      }
    }

    merged.push(current);
  }

  return merged.join('\n');
}

/** Rough sanity check on an extraction. */
export function assessResumeText(text: string): { ok: boolean; warning?: string } {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 80) {
    return {
      ok: false,
      warning: `Only ${words} words came out of that file. It is probably a scanned image rather than a text PDF - run it through OCR, or paste the text into your profile instead.`,
    };
  }
  if (!/@/.test(text)) {
    return { ok: true, warning: 'No email address found in the extracted text; the extraction may be partial.' };
  }

  // Check for suspicious truncation patterns (e.g., "Ban" instead of "Bangalore")
  const truncationWarning = detectTruncation(text);
  if (truncationWarning) {
    return { ok: true, warning: truncationWarning };
  }

  return { ok: true };
}

/**
 * Detect suspicious truncation patterns that may indicate multi-column PDF issues.
 * Common signs: very short location tokens (3-4 chars) that should be longer.
 */
function detectTruncation(text: string): string | null {
  const lines = text.split('\n');
  const suspiciousTokens: string[] = [];

  for (const line of lines) {
    const tokens = line.trim().split(/\s+/);
    for (const token of tokens) {
      // Check for suspiciously short tokens that could be truncated city/state names
      if (token.length >= 2 && token.length <= 4) {
        const normalized = normalizeCityName(token);
        // If the token is not a known short form and could be a truncation
        if (!normalized && /^[A-Z][a-z]{1,3}$/.test(token)) {
          suspiciousTokens.push(token);
        }
      }
    }
  }

  // If we found many suspicious short tokens, flag it
  if (suspiciousTokens.length >= 3) {
    return `Detected ${suspiciousTokens.length} suspiciously short tokens (${suspiciousTokens.slice(0, 3).join(', ')}${suspiciousTokens.length > 3 ? '...' : ''}). This may indicate a multi-column PDF layout that truncated text extraction. Review the extracted text carefully.`;
  }

  return null;
}
