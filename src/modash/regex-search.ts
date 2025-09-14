/**
 * Enhanced Regex Search Implementation with Bloom Filter Prefiltering
 * 
 * Enhances $regex operator with trigram-based Bloom filtering for Phase 3.5
 * Target: 3x speedup for patterns with 3+ literal characters and <1% false positive rate
 */

import type { Collection, Document } from './expressions.js';
import { RegexSearchBloomFilter, extractLiteralsFromRegex, extractTrigrams } from './bloom-filter.js';
import { DEBUG } from './debug.js';

/**
 * Regex search statistics for monitoring and debugging
 */
export interface RegexSearchStats {
  totalQueries: number;
  prefilterHits: number;
  candidatesBeforeFilter: number;
  candidatesAfterFilter: number;
  actualMatches: number;
  falsePositiveRate: number;
  averageSpeedupRatio: number;
  totalPrefilterTime: number;
  totalVerificationTime: number;
  unsupportedPatterns: number;
  shortPatterns: number;
}

/**
 * Regex search configuration
 */
export interface RegexSearchConfig {
  enableBloomFilter: boolean;
  bloomFilterSizeBytes: number;
  minLiteralLength: number;
  maxPatternComplexity: number;
}

/**
 * Global regex search statistics
 */
let regexSearchStats: RegexSearchStats = {
  totalQueries: 0,
  prefilterHits: 0,
  candidatesBeforeFilter: 0,
  candidatesAfterFilter: 0,
  actualMatches: 0,
  falsePositiveRate: 0,
  averageSpeedupRatio: 1.0,
  totalPrefilterTime: 0,
  totalVerificationTime: 0,
  unsupportedPatterns: 0,
  shortPatterns: 0,
};

/**
 * Default configuration
 */
const defaultConfig: RegexSearchConfig = {
  enableBloomFilter: true,
  bloomFilterSizeBytes: 256,
  minLiteralLength: 3,
  maxPatternComplexity: 100,
};

/**
 * Global Bloom filter for regex search
 */
let globalRegexSearchFilter: RegexSearchBloomFilter | null = null;

/**
 * Initialize or get the global regex search filter
 */
function getGlobalRegexFilter(): RegexSearchBloomFilter {
  if (!globalRegexSearchFilter) {
    globalRegexSearchFilter = new RegexSearchBloomFilter(defaultConfig.bloomFilterSizeBytes, 3);
  }
  return globalRegexSearchFilter;
}

/**
 * Enhanced $regex operator with Bloom filter acceleration
 */
export function enhancedRegexMatch<T extends Document = Document>(
  collection: Collection<T>,
  field: string,
  pattern: string,
  options: string = '',
  config: Partial<RegexSearchConfig> = {}
): Collection<T> {
  const startTime = performance.now();
  const mergedConfig = { ...defaultConfig, ...config };
  
  regexSearchStats.totalQueries++;
  
  if (!pattern || typeof pattern !== 'string') {
    if (DEBUG) {
      console.log('🔍 $regex: Empty or invalid pattern, returning empty result');
    }
    return [];
  }

  // Check pattern complexity and literal content
  const literals = extractLiteralsFromRegex(pattern);
  const hasUsefulLiterals = literals.some(lit => lit.length >= mergedConfig.minLiteralLength);
  
  if (!mergedConfig.enableBloomFilter || !hasUsefulLiterals || pattern.length > mergedConfig.maxPatternComplexity) {
    if (DEBUG) {
      const reason = !hasUsefulLiterals ? 'insufficient literals' : 'pattern too complex';
      console.log(`🔍 $regex: Skipping Bloom prefilter - ${reason}`);
    }
    
    if (!hasUsefulLiterals) regexSearchStats.shortPatterns++;
    if (pattern.length > mergedConfig.maxPatternComplexity) regexSearchStats.unsupportedPatterns++;
    
    return performFullRegexSearch(collection, field, pattern, options);
  }

  // Try Bloom filter prefiltering
  const filter = getGlobalRegexFilter();
  const prefilterStartTime = performance.now();
  
  // Build document index if not already built
  buildRegexDocumentIndex(collection, field, filter);
  
  const { candidates, shouldUsePrefilter, falsePositiveRate } = filter.testRegexPattern(pattern);
  const prefilterEndTime = performance.now();
  
  regexSearchStats.candidatesBeforeFilter += collection.length;
  regexSearchStats.candidatesAfterFilter += candidates.length;
  regexSearchStats.totalPrefilterTime += (prefilterEndTime - prefilterStartTime);
  
  if (DEBUG) {
    console.log(`🔍 $regex Bloom prefilter: ${collection.length} -> ${candidates.length} candidates (${((1 - candidates.length / collection.length) * 100).toFixed(1)}% reduction)`);
    console.log(`🔍 $regex literals found: ${literals.join(', ')}`);
    console.log(`🔍 $regex estimated FPR: ${(falsePositiveRate * 100).toFixed(2)}%`);
  }

  // If prefiltering didn't help or shouldn't be used, fall back to full scan
  if (!shouldUsePrefilter || candidates.length > collection.length * 0.7) {
    if (DEBUG) {
      console.log('🔍 $regex: Prefilter not effective, falling back to full scan');
    }
    return performFullRegexSearch(collection, field, pattern, options);
  }

  regexSearchStats.prefilterHits++;
  
  // Filter collection to candidate documents and verify
  const verificationStartTime = performance.now();
  const candidateSet = new Set(candidates);
  const candidateDocs = collection.filter((doc, index) => 
    candidateSet.has(index.toString()) || candidateSet.has((doc as any)._id?.toString())
  );
  
  const results = performFullRegexSearch(candidateDocs, field, pattern, options);
  const verificationEndTime = performance.now();
  
  regexSearchStats.totalVerificationTime += (verificationEndTime - verificationStartTime);
  regexSearchStats.actualMatches += results.length;
  
  const totalTime = performance.now() - startTime;
  const estimatedFullScanTime = (totalTime / candidateDocs.length) * collection.length;
  const speedupRatio = candidateDocs.length > 0 ? estimatedFullScanTime / totalTime : 1.0;
  
  regexSearchStats.averageSpeedupRatio = (
    (regexSearchStats.averageSpeedupRatio * (regexSearchStats.totalQueries - 1) + speedupRatio) / 
    regexSearchStats.totalQueries
  );
  
  if (DEBUG) {
    console.log(`🔍 $regex: Found ${results.length} matches, estimated speedup: ${speedupRatio.toFixed(1)}x`);
  }

  return results;
}

/**
 * Build document index for regex Bloom filtering
 */
function buildRegexDocumentIndex<T extends Document>(
  collection: Collection<T>,
  field: string,
  filter: RegexSearchBloomFilter
): void {
  collection.forEach((doc, index) => {
    const docId = (doc as any)._id?.toString() || index.toString();
    
    // Extract field value for regex matching
    const fieldValue = getNestedFieldValue(doc, field);
    if (typeof fieldValue === 'string') {
      filter.addDocument(docId, fieldValue);
    }
  });
}

/**
 * Get nested field value from document using dot notation
 */
function getNestedFieldValue(obj: any, path: string): any {
  const keys = path.split('.');
  let current = obj;
  
  for (const key of keys) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = current[key];
  }
  
  return current;
}

/**
 * Perform full regex search without prefiltering
 */
function performFullRegexSearch<T extends Document>(
  collection: Collection<T>,
  field: string,
  pattern: string,
  options: string = ''
): Collection<T> {
  let regex: RegExp;
  
  try {
    regex = new RegExp(pattern, options);
  } catch (error) {
    if (DEBUG) {
      console.log(`🔍 $regex: Invalid regex pattern: ${pattern}`);
    }
    return [];
  }
  
  return collection.filter(doc => {
    const fieldValue = getNestedFieldValue(doc, field);
    if (typeof fieldValue !== 'string') return false;
    
    return regex.test(fieldValue);
  });
}

/**
 * Check if a regex pattern is suitable for Bloom prefiltering
 */
export function analyzeRegexPattern(pattern: string): {
  literals: string[];
  trigrams: string[];
  suitableForBloom: boolean;
  complexity: number;
} {
  const literals = extractLiteralsFromRegex(pattern);
  const trigrams: string[] = [];
  
  literals.forEach(literal => {
    trigrams.push(...extractTrigrams(literal));
  });
  
  const complexity = pattern.length + (pattern.match(/[.*+?^${}()|[\]\\]/g) || []).length;
  const suitableForBloom = literals.some(lit => lit.length >= 3) && complexity <= 100;
  
  return {
    literals,
    trigrams,
    suitableForBloom,
    complexity,
  };
}

/**
 * Reset regex search statistics
 */
export function resetRegexSearchStats(): void {
  regexSearchStats = {
    totalQueries: 0,
    prefilterHits: 0,
    candidatesBeforeFilter: 0,
    candidatesAfterFilter: 0,
    actualMatches: 0,
    falsePositiveRate: 0,
    averageSpeedupRatio: 1.0,
    totalPrefilterTime: 0,
    totalVerificationTime: 0,
    unsupportedPatterns: 0,
    shortPatterns: 0,
  };
}

/**
 * Get current regex search statistics
 */
export function getRegexSearchStats(): RegexSearchStats {
  const stats = { ...regexSearchStats };
  
  // Calculate derived metrics
  if (stats.candidatesBeforeFilter > 0) {
    stats.falsePositiveRate = stats.candidatesAfterFilter > stats.actualMatches ? 
      (stats.candidatesAfterFilter - stats.actualMatches) / stats.candidatesAfterFilter : 0;
  }
  
  return stats;
}

/**
 * Configure regex search behavior
 */
export function configureRegexSearch(config: Partial<RegexSearchConfig>): void {
  Object.assign(defaultConfig, config);
  
  // Reset filter if configuration changed significantly
  if (globalRegexSearchFilter && (
    config.bloomFilterSizeBytes !== undefined ||
    config.enableBloomFilter === false
  )) {
    globalRegexSearchFilter = null;
  }
}

/**
 * Clear regex search index (useful for testing or memory management)
 */
export function clearRegexSearchIndex(): void {
  if (globalRegexSearchFilter) {
    globalRegexSearchFilter.clear();
  }
  globalRegexSearchFilter = null;
}