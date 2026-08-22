import path from 'node:path';
import { readFile } from 'node:fs/promises';

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
    const { text } = await extractText(pdf, { mergePages: true });
    return clean(Array.isArray(text) ? text.join('\n') : text);
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

function clean(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
  return { ok: true };
}
