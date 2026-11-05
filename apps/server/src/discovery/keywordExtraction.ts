import { tokenize, normalizeLabel } from '@ja/shared';
import { prisma } from '../lib/db.js';

/**
 * Extract keywords from resume text for job matching and search.
 *
 * Keywords are categorized by type (skills, roles, domains, tools) and weighted
 * by their importance in the resume. This drives both search query generation
 * and job matching.
 */

export interface ResumeKeyword {
  keyword: string;
  weight: number;
  category: 'skill' | 'role' | 'domain' | 'tool' | 'general';
}

/**
 * Role-related keywords that indicate the type of engineering position.
 */
const ROLE_KEYWORDS = [
  'backend', 'frontend', 'full stack', 'fullstack', 'full-stack',
  'devops', 'sre', 'site reliability', 'platform', 'infrastructure',
  'data engineer', 'machine learning', 'ml', 'ai', 'artificial intelligence',
  'mobile', 'ios', 'android', 'web', 'software engineer', 'developer',
  'engineering', 'engineering manager', 'tech lead', 'staff', 'principal',
  'security', 'appsec', 'qa', 'quality assurance', 'testing',
];

/**
 * Common tech skills and tools to recognize.
 */
const TECH_KEYWORDS = [
  'go', 'golang', 'rust', 'python', 'java', 'kotlin', 'scala', 'ruby', 'elixir', 'c++', 'c',
  'typescript', 'javascript', 'js', 'ts', 'react', 'vue', 'angular', 'node', 'node.js',
  'swift', 'objective-c', 'dart', 'flutter', 'react native',
  'postgres', 'postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'cassandra',
  'kafka', 'rabbitmq', 'aws', 'gcp', 'azure', 'cloud', 'docker', 'kubernetes', 'k8s',
  'terraform', 'ansible', 'chef', 'puppet', 'ci/cd', 'jenkins', 'github actions',
  'graphql', 'grpc', 'rest', 'api', 'microservices', 'soa',
  'tensorflow', 'pytorch', 'keras', 'scikit-learn', 'pandas', 'numpy', 'spark',
  'linux', 'unix', 'bash', 'shell', 'git', 'svn', 'mercurial',
  'agile', 'scrum', 'kanban', 'tdd', 'bdd',
];

/**
 * Domain-specific keywords that indicate industry or business domain.
 */
const DOMAIN_KEYWORDS = [
  'fintech', 'finance', 'banking', 'payments', 'insurance',
  'healthcare', 'medical', 'health', 'biotech', 'pharma',
  'ecommerce', 'e-commerce', 'retail', 'marketplace',
  'saas', 'paas', 'iaas', 'b2b', 'b2c', 'consumer',
  'social', 'media', 'gaming', 'entertainment', 'streaming',
  'education', 'edtech', 'learning', 'teaching',
  'logistics', 'supply chain', 'transportation', 'delivery',
  'manufacturing', 'iot', 'hardware', 'embedded',
];

/**
 * Extract keywords from resume text.
 *
 * Analyzes the resume text and extracts relevant keywords with weights and categories.
 * Keywords are weighted based on frequency and position in the resume.
 */
export function extractResumeKeywords(resumeText: string): ResumeKeyword[] {
  if (!resumeText || resumeText.trim().length < 100) {
    return [];
  }

  const normalized = normalizeLabel(resumeText);
  const tokens = tokenize(normalized);
  const tokenCounts = new Map<string, number>();

  // Count token frequency
  for (const token of tokens) {
    tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
  }

  const keywords: ResumeKeyword[] = [];
  const seen = new Set<string>();

  // Extract role keywords
  for (const role of ROLE_KEYWORDS) {
    const normalizedRole = normalizeLabel(role);
    const isMultiWord = role.includes(' ');
    // For single-word keywords, rely on tokenCounts to avoid false positives
    // For multi-word phrases, use includes() since tokenize splits them
    const matched = isMultiWord ? normalized.includes(normalizedRole) : tokenCounts.has(normalizedRole);
    if (matched) {
      const count = tokenCounts.get(normalizedRole) || 0;
      const weight = Math.min(count * 3 + 5, 10); // Base weight + frequency
      if (!seen.has(normalizedRole)) {
        keywords.push({ keyword: role, weight, category: 'role' });
        seen.add(normalizedRole);
      }
    }
  }

  // Extract tech keywords
  for (const tech of TECH_KEYWORDS) {
    const normalizedTech = normalizeLabel(tech);
    const isMultiWord = tech.includes(' ');
    // For single-word keywords, rely on tokenCounts to avoid false positives
    // For multi-word phrases, use includes() since tokenize splits them
    const matched = isMultiWord ? normalized.includes(normalizedTech) : tokenCounts.has(normalizedTech);
    if (matched) {
      const count = tokenCounts.get(normalizedTech) || 0;
      const weight = Math.min(count * 2 + 3, 8); // Tech skills are important
      if (!seen.has(normalizedTech)) {
        keywords.push({ keyword: tech, weight, category: 'skill' });
        seen.add(normalizedTech);
      }
    }
  }

  // Extract domain keywords
  for (const domain of DOMAIN_KEYWORDS) {
    const normalizedDomain = normalizeLabel(domain);
    const isMultiWord = domain.includes(' ');
    // For single-word keywords, rely on tokenCounts to avoid false positives
    // For multi-word phrases, use includes() since tokenize splits them
    const matched = isMultiWord ? normalized.includes(normalizedDomain) : tokenCounts.has(normalizedDomain);
    if (matched) {
      const count = tokenCounts.get(normalizedDomain) || 0;
      const weight = Math.min(count * 2 + 2, 6); // Domain is moderately important
      if (!seen.has(normalizedDomain)) {
        keywords.push({ keyword: domain, weight, category: 'domain' });
        seen.add(normalizedDomain);
      }
    }
  }

  // Extract high-frequency general terms (not in stop lists)
  for (const [token, count] of tokenCounts.entries()) {
    if (count >= 3 && !seen.has(token) && token.length > 2) {
      // Filter out common words
      if (!['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'will', 'with', 'this', 'that', 'from', 'they', 'would', 'there', 'their', 'what', 'about', 'which', 'when', 'make', 'like', 'just', 'over', 'such', 'into', 'year', 'your', 'some', 'them', 'than', 'then', 'look', 'only', 'come', 'could', 'after', 'also', 'should'].includes(token)) {
        keywords.push({ keyword: token, weight: Math.min(count, 4), category: 'general' });
        seen.add(token);
      }
    }
  }

  // Sort by weight and return top keywords
  return keywords
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 50); // Limit to top 50 keywords
}

/**
 * Get primary role from resume keywords.
 *
 * Returns the highest-weighted role keyword, or null if no role is detected.
 */
export function getPrimaryRole(keywords: ResumeKeyword[]): string | null {
  const roleKeywords = keywords.filter(k => k.category === 'role');
  if (roleKeywords.length === 0) return null;
  return roleKeywords[0]?.keyword || null;
}

/**
 * Get top skills from resume keywords.
 *
 * Returns the top N skill keywords by weight.
 */
export function getTopSkills(keywords: ResumeKeyword[], limit = 10): string[] {
  return keywords
    .filter(k => k.category === 'skill')
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map(k => k.keyword);
}

/**
 * Get domains from resume keywords.
 *
 * Returns all domain keywords.
 */
export function getDomains(keywords: ResumeKeyword[]): string[] {
  return keywords
    .filter(k => k.category === 'domain')
    .map(k => k.keyword);
}

/**
 * Update profile keywords based on resume text.
 *
 * Extracts keywords from the resume and stores them in the profile.
 * This should be called whenever the resume is updated.
 *
 * This function uses an optimistic concurrency check to prevent race conditions
 * where an older keyword extraction could overwrite a newer one.
 */
export async function updateProfileKeywords(profileId: string, expectedResumeText?: string): Promise<void> {
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: { resumeText: true },
  });

  if (!profile) {
    return; // Profile doesn't exist, nothing to update
  }

  // If expectedResumeText is provided, verify it matches current to prevent stale overwrites
  if (expectedResumeText !== undefined && profile.resumeText !== expectedResumeText) {
    // Resume text has changed since this operation started, skip update
    // A newer operation will handle the updated text
    return;
  }

  if (!profile.resumeText) {
    // Clear keywords if no resume
    await prisma.profile.update({
      where: { id: profileId },
      data: { resumeKeywords: null as any },
    });
    return;
  }

  const keywords = extractResumeKeywords(profile.resumeText);

  // Use optimistic concurrency check to ensure we're not overwriting with stale data
  const result = await prisma.profile.updateMany({
    where: {
      id: profileId,
      resumeText: profile.resumeText, // Only update if resume text hasn't changed
    },
    data: { resumeKeywords: keywords as any },
  });

  // If no rows were updated, it means the resume text changed and another
  // operation will handle the keyword extraction
  if (result.count === 0) {
    // Silently skip - a newer operation will handle this
  }
}
