import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TabStopType,
  TextRun,
} from 'docx';
import { config } from '../lib/config.js';

/**
 * Write the tailored resume out as files an ATS can actually read.
 *
 * The rules that matter for machine parsing, all of which this respects:
 *  - one column, no tables, no text boxes, no headers or footers, no images
 *  - real paragraph styles rather than visual formatting
 *  - a common font (Calibri/Arial), 10-12pt
 *  - "- " bullets rather than glyphs a parser may drop or mangle
 *  - section headings spelled the conventional way
 *
 * A plain .txt goes alongside the .docx, because a handful of older systems
 * still parse it more reliably than anything else, and it is what you paste
 * into a textarea when a form offers "enter manually".
 */

const SECTION_RE =
  /^(SUMMARY|PROFILE|OBJECTIVE|EXPERIENCE|WORK EXPERIENCE|PROFESSIONAL EXPERIENCE|EMPLOYMENT|SKILLS|TECHNICAL SKILLS|EDUCATION|PROJECTS|CERTIFICATIONS|PUBLICATIONS|AWARDS|LANGUAGES|VOLUNTEER)\s*:?\s*$/i;

export interface RenderedResume {
  txtPath: string;
  docxPath: string;
  txtAbsolute: string;
  docxAbsolute: string;
}

export async function renderResume(
  text: string,
  opts: { profileName: string; slug: string },
): Promise<RenderedResume> {
  const dir = path.join(config.storageDir, 'resumes', 'tailored');
  await mkdir(dir, { recursive: true });

  const base = `${sanitise(opts.profileName)}-${sanitise(opts.slug)}-${Date.now()}`;
  const txtAbsolute = path.join(dir, `${base}.txt`);
  const docxAbsolute = path.join(dir, `${base}.docx`);

  const normalised = normaliseForAts(text);
  await writeFile(txtAbsolute, normalised, 'utf8');
  await writeFile(docxAbsolute, await buildDocx(normalised));

  return {
    txtPath: path.relative(config.storageDir, txtAbsolute),
    docxPath: path.relative(config.storageDir, docxAbsolute),
    txtAbsolute,
    docxAbsolute,
  };
}

/** Strip the things that trip parsers, before anything is written. */
export function normaliseForAts(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      // A tab next to a bullet is a two-column layout, which is the single most
      // reliable way to scramble an ATS parse: it reads across the columns.
      // Split those into separate lines before anything else touches them.
      .replace(/[ \t]*\t[ \t]*(?=[\u2022\u25AA\u25E6\u2023\u00B7*-]\s)/g, '\n')
      .replace(/\t/g, ' ')
      // Bullet glyphs become a plain hyphen wherever they appear. Some parsers
      // drop the glyph and silently glue the bullet onto the previous line.
      .replace(/^[ ]*[\u2022\u25AA\u25E6\u2023\u00B7*]\s+/gm, '- ')
      .replace(/[\u2022\u25AA\u25E6\u2023]\s*/g, '- ')
      // Smart punctuation round-trips badly through older parsers.
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u2013\u2014\u2212]/g, '-')
      .replace(/\u00A0/g, ' ')
      .replace(/[ ]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

async function buildDocx(text: string): Promise<Buffer> {
  const lines = text.split('\n');
  const children: Paragraph[] = [];

  // The first non-empty line is the name; the next few are contact details.
  let seenName = false;
  let contactZone = true;

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line.trim()) {
      contactZone = contactZone && !seenName ? contactZone : false;
      children.push(new Paragraph({ text: '', spacing: { after: 80 } }));
      continue;
    }

    if (!seenName) {
      seenName = true;
      children.push(
        new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing: { after: 40 },
          children: [new TextRun({ text: line.trim(), bold: true, size: 30 })],
        }),
      );
      continue;
    }

    if (SECTION_RE.test(line.trim())) {
      contactZone = false;
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 220, after: 80 },
          children: [
            new TextRun({ text: line.trim().replace(/:$/, '').toUpperCase(), bold: true, size: 24 }),
          ],
        }),
      );
      continue;
    }

    if (/^-\s+/.test(line.trim())) {
      contactZone = false;
      children.push(
        new Paragraph({
          spacing: { after: 40 },
          indent: { left: 220, hanging: 220 },
          children: [new TextRun({ text: line.trim(), size: 21 })],
        }),
      );
      continue;
    }

    children.push(
      new Paragraph({
        spacing: { after: 40 },
        children: [new TextRun({ text: line.trim(), size: 21, bold: isRoleLine(line) })],
      }),
    );
  }

  const doc = new Document({
    creator: 'job-applier',
    description: 'ATS-formatted resume',
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 21 } },
        heading1: { run: { font: 'Calibri', bold: true, size: 24, color: '000000' } },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 720, bottom: 720, left: 720, right: 720 },
          },
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

/** "Staff Engineer, Stripe — Jan 2019 - Present" style lines get bolded. */
function isRoleLine(line: string): boolean {
  return /\b(19|20)\d{2}\b/.test(line) && /[-–—|,]/.test(line) && line.length < 120;
}

const sanitise = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'resume';

// Kept for callers that want a tab-stop paragraph; docx requires the import to
// be used for the type to be re-exported cleanly.
export const TAB_STOP_RIGHT = TabStopType.RIGHT;
