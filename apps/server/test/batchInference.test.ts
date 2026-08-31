import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

process.env.LLM_PROVIDER = 'gemini';
process.env.GEMINI_API_KEY = 'test-key';

const generateContent = vi.fn();
vi.mock('@google/genai', async () => {
  const actual = await vi.importActual<typeof import('@google/genai')>('@google/genai');
  return {
    ...actual,
    GoogleGenAI: class {
      models = { generateContent };
    },
  };
});

const { inferBatchAnswers } = await import('../src/llm/inferAnswer.js');
const { FormField } = await import('@ja/shared');

describe('batch inference', () => {
  beforeEach(() => {
    generateContent.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it('handles empty field array', async () => {
    const result = await inferBatchAnswers({
      candidateContext: 'Some context',
      fields: [],
      jobTitle: 'Engineer',
      companyName: 'Acme',
    });
    expect(result.size).toBe(0);
  });

  it('makes a single API call for multiple fields', async () => {
    const fields: any[] = [
      {
        id: 'field1',
        label: 'Notice Period',
        kind: 'TEXT',
        required: true,
        selector: '#field1',
      },
      {
        id: 'field2',
        label: 'Years of Experience',
        kind: 'TEXT',
        required: true,
        selector: '#field2',
      },
    ];

    generateContent.mockResolvedValue({
      text: JSON.stringify({
        answers: {
          field1: {
            answerable: true,
            value: '1 month',
            values: [],
            confidence: 0.9,
            evidence: 'Stated in resume',
            missingInformation: '',
          },
          field2: {
            answerable: true,
            value: '5 years',
            values: [],
            confidence: 0.95,
            evidence: 'Calculated from work history',
            missingInformation: '',
          },
        },
      }),
    });

    const result = await inferBatchAnswers({
      candidateContext: 'Some context',
      fields,
      jobTitle: 'Engineer',
      companyName: 'Acme',
    });

    // Should have called generateContent exactly once
    expect(generateContent).toHaveBeenCalledTimes(1);
    
    // Should have results for both fields
    expect(result.size).toBe(2);
    expect(result.get('field1')?.value).toBe('1 month');
    expect(result.get('field2')?.value).toBe('5 years');
  });

  it('falls back to individual calls on batch failure', async () => {
    const fields: any[] = [
      {
        id: 'field1',
        label: 'Notice Period',
        kind: 'TEXT',
        required: true,
        selector: '#field1',
      },
    ];

    generateContent.mockRejectedValue(new Error('API error'));

    const result = await inferBatchAnswers({
      candidateContext: 'Some context',
      fields,
      jobTitle: 'Engineer',
      companyName: 'Acme',
    });

    // Should still return a result for the field (even if it's an error result)
    expect(result.size).toBe(1);
    expect(result.get('field1')?.answerable).toBe(false);
  });

  it('validates options for select fields', async () => {
    const fields: any[] = [
      {
        id: 'field1',
        label: 'Remote Work',
        kind: 'SELECT',
        required: true,
        selector: '#field1',
        options: [
          { label: 'Remote', value: 'remote' },
          { label: 'Hybrid', value: 'hybrid' },
          { label: 'On-site', value: 'onsite' },
        ],
      },
    ];

    generateContent.mockResolvedValue({
      text: JSON.stringify({
        answers: {
          field1: {
            answerable: true,
            value: 'Remote',
            values: [],
            confidence: 0.9,
            evidence: 'Stated in resume',
            missingInformation: '',
          },
        },
      }),
    });

    const result = await inferBatchAnswers({
      candidateContext: 'Some context',
      fields,
      jobTitle: 'Engineer',
      companyName: 'Acme',
    });

    // Should accept valid option
    expect(result.get('field1')?.value).toBe('Remote');
  });

  it('rejects invalid options for select fields', async () => {
    const fields: any[] = [
      {
        id: 'field1',
        label: 'Remote Work',
        kind: 'SELECT',
        required: true,
        selector: '#field1',
        options: [
          { label: 'Remote', value: 'remote' },
          { label: 'Hybrid', value: 'hybrid' },
        ],
      },
    ];

    generateContent.mockResolvedValue({
      text: JSON.stringify({
        answers: {
          field1: {
            answerable: true,
            value: 'Invalid Option',
            values: [],
            confidence: 0.9,
            evidence: 'Stated in resume',
            missingInformation: '',
          },
        },
      }),
    });

    const result = await inferBatchAnswers({
      candidateContext: 'Some context',
      fields,
      jobTitle: 'Engineer',
      companyName: 'Acme',
    });

    // Should reject invalid option
    expect(result.get('field1')?.answerable).toBe(false);
    expect(result.get('field1')?.missingInformation).toContain('not on the form');
  });
});
