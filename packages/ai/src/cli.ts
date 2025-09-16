#!/usr/bin/env node

/**
 * AI CLI for aggo - Natural language query interface
 *
 * Usage:
 *   cat data.jsonl | aggo ai "average score by category"
 *   aggo ai "sum total where status is active" --file data.jsonl
 */

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { Command } from 'commander';
import {
  getSchema,
  generatePipeline,
  validateConfiguration,
  formatSchema,
} from './index.js';
import { StructuredOpenAIClient } from './structured-client.js';
import { executePipelineString } from './engine/run_pipeline.js';
import { renderTUIApp } from './tui-app.js';
import { SPINNER_PHASES, withSpinner, createPhaseSpinner } from './spinner.js';
import type { Document } from 'aggo';

interface CLIOptions {
  file?: string;
  schemaOnly?: boolean;
  showPipeline?: boolean;
  structured?: boolean;
  tui?: boolean;
  streaming?: boolean;
  emitMs?: number;
  maxDocs?: number;
  limitSample?: number;
  model?: string;
  explain?: boolean;
  pretty?: boolean;
  apiKey?: string;
}

const program = new Command();

program
  .name('aggo-ai')
  .description('AI-powered natural language queries for JSON data using aggo')
  .version('0.2.0')
  .argument('[query]', 'Natural language query')
  .option('-f, --file <path>', 'Read data from file instead of stdin')
  .option('--schema-only', 'Show inferred schema without querying')
  .option('--show-pipeline', "Print generated pipeline but don't run it")
  .option('--structured', 'Use structured output mode (pipeline + UIDSL)')
  .option('--tui', 'Launch interactive TUI (implies --structured)')
  .option('--streaming', 'Enable streaming mode for live updates')
  .option('--emit-ms <ms>', 'Streaming update interval in milliseconds', parseInt)
  .option('--max-docs <n>', 'Maximum documents to process', parseInt)
  .option(
    '--limit-sample <n>',
    'Control rows sampled for schema inference',
    parseInt
  )
  .option(
    '--model <model>',
    'Override default OpenAI model',
    'gpt-4o-2024-08-06'
  )
  .option('--explain', 'Include explanation of the generated pipeline')
  .option('--pretty', 'Pretty-print JSON output')
  .option('--api-key <key>', 'OpenAI API key (or use OPENAI_API_KEY env var)')
  .action(async (query: string | undefined, options: CLIOptions) => {
    try {
      await runAICommand(query, options);
    } catch (error) {
      console.error(
        `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      process.exit(1);
    }
  });

// Add help examples
program.addHelpText(
  'after',
  `
Examples:
  # Structured output mode with TUI
  cat sales.jsonl | aggo-ai "revenue by category" --tui
  
  # Streaming dashboard
  tail -f logs.jsonl | aggo-ai "error count by service" --tui --streaming
  
  # Basic natural language query
  cat sales.jsonl | aggo-ai "total revenue by product category"
  
  # Show inferred schema
  cat data.jsonl | aggo-ai --schema-only
  
  # Generate pipeline without executing
  aggo-ai "average rating by genre" --file movies.jsonl --show-pipeline
  
  # Use specific OpenAI model
  cat logs.jsonl | aggo-ai "error count by service" --model gpt-4
  
  # Get detailed explanation
  aggo-ai "top 10 customers by order value" --file orders.jsonl --explain

Environment Variables:
  OPENAI_API_KEY    OpenAI API key for pipeline generation (required)

Note: This command requires an OpenAI API key to convert natural language
queries into MongoDB aggregation pipelines. Use --tui for interactive
terminal interfaces with tables, charts, and real-time updates.
`
);

async function runAICommand(
  query: string | undefined,
  options: CLIOptions
): Promise<void> {
  // Read input documents first
  const documents = await readInputDocuments(options);

  if (documents.length === 0) {
    console.error('⚠️  No documents found in input');
    return;
  }

  console.error(`📊 Loaded ${documents.length.toLocaleString()} documents`);

  // Handle schema-only mode (no OpenAI required)
  if (options.schemaOnly) {
    const schema = await withSpinner(
      () =>
        Promise.resolve(
          getSchema(documents, { sampleSize: options.limitSample })
        ),
      SPINNER_PHASES.SCHEMA_INFERENCE,
      { successMessage: '✅ Schema analysis completed' }
    );
    console.log('📋 Inferred Schema:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(formatSchema(schema));
    return;
  }

  // Validate OpenAI configuration for modes that need it
  const openaiOptions = {
    apiKey: options.apiKey,
    model: options.model,
  };

  // Test OpenAI connection with spinner
  const isConfigValid = await withSpinner(
    () => validateConfiguration(openaiOptions),
    'Validating OpenAI connection',
    {
      successMessage: '✅ OpenAI connection verified',
      errorMessage: '❌ OpenAI connection failed',
    }
  );

  if (!isConfigValid) {
    console.error(
      '💡 Hint: Check your OPENAI_API_KEY environment variable or --api-key option'
    );
    process.exit(1);
  }

  // Validate query is provided for non-schema modes
  if (!query) {
    console.error('❌ Error: Query is required');
    console.error(
      '💡 Use --schema-only to see the data schema, or provide a natural language query'
    );
    process.exit(1);
  }

  console.error(`🤖 Processing query: "${query}"`);

  // Handle show-pipeline mode
  if (options.showPipeline) {
    // Schema inference with spinner
    const schema = await withSpinner(
      () =>
        Promise.resolve(
          getSchema(documents, { sampleSize: options.limitSample })
        ),
      SPINNER_PHASES.SCHEMA_INFERENCE,
      { successMessage: '✅ Schema analyzed' }
    );

    // Pipeline generation with spinner
    const result = await withSpinner(
      () =>
        generatePipeline(query, schema, documents.slice(0, 3), openaiOptions),
      SPINNER_PHASES.OPENAI_GENERATION,
      { successMessage: '✅ Pipeline generated' }
    );

    console.log('🔧 Generated Pipeline:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(JSON.stringify(result.pipeline, null, 2));

    if (result.explanation) {
      console.log('\n💡 Explanation:');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(result.explanation);
    }

    if (result.tokensUsed) {
      console.error(
        `\n📊 Tokens used: ${result.tokensUsed.total} (prompt: ${result.tokensUsed.prompt}, completion: ${result.tokensUsed.completion})`
      );
    }

    return;
  }

  // Handle structured output / TUI mode
  if (options.structured || options.tui) {
    await runStructuredMode(query, documents, options);
    return;
  }

  // Execute full AI query with enhanced spinner experience
  const startTime = Date.now();
  const result = await executeAIQueryWithSpinners(documents, query, {
    ...openaiOptions,
    sampleSize: options.limitSample,
    includeExplanation: options.explain,
  });
  const totalTime = Date.now() - startTime;

  // Show performance stats
  if (result.performance) {
    console.error('⚡ Performance:');
    console.error(
      `   Schema inference: ${result.performance.schemaInferenceMs}ms`
    );
    console.error(
      `   Pipeline generation: ${result.performance.pipelineGenerationMs}ms`
    );
    console.error(`   Execution: ${result.performance.executionMs}ms`);
    console.error(`   Total: ${totalTime}ms`);
  }

  if (result.tokensUsed) {
    console.error(
      `💰 Tokens used: ${result.tokensUsed.total} (prompt: ${result.tokensUsed.prompt}, completion: ${result.tokensUsed.completion})`
    );
  }

  // Show explanation if requested
  if (result.explanation) {
    console.error('\n💡 Explanation:');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(result.explanation);
    console.error('');
  }

  // Output results
  console.log(formatOutput(result.results, options.pretty || false));
}

/**
 * Execute AI query with enhanced spinner UX for each phase
 */
async function executeAIQueryWithSpinners(
  documents: Document[],
  query: string,
  options: any
) {
  // Phase 1: Schema Inference
  const schemaSpinner = createPhaseSpinner('SCHEMA_INFERENCE');
  schemaSpinner.start(SPINNER_PHASES.SCHEMA_INFERENCE);

  let schema;
  try {
    // Simulate some processing time and show different phrases
    await new Promise(resolve => setTimeout(resolve, 200));
    schemaSpinner.nextPhrase();

    schema = getSchema(documents, { sampleSize: options.sampleSize });

    await new Promise(resolve => setTimeout(resolve, 100));
    schemaSpinner.stop('✅ Schema analysis completed');
  } catch (error) {
    schemaSpinner.stop('❌ Schema analysis failed', 'red');
    throw error;
  }

  // Phase 2: Pipeline Generation
  const samples = documents.slice(0, 3);
  const pipelineSpinner = createPhaseSpinner('OPENAI_GENERATION');
  pipelineSpinner.start(SPINNER_PHASES.OPENAI_GENERATION);

  let generationResult;
  try {
    // Show variety in OpenAI communication
    await new Promise(resolve => setTimeout(resolve, 300));
    pipelineSpinner.nextPhrase();

    // Dynamic import to avoid circular dependency
    const { OpenAIClient } = await import('./openai-client.js');
    const client = new OpenAIClient(options);

    await new Promise(resolve => setTimeout(resolve, 200));
    pipelineSpinner.nextPhrase();

    generationResult = await client.generatePipeline(query, schema, samples, {
      includeExplanation: options.includeExplanation,
    });

    pipelineSpinner.stop('✅ Pipeline generated successfully');
  } catch (error) {
    pipelineSpinner.stop('❌ Pipeline generation failed', 'red');
    throw error;
  }

  // Phase 3: Execution
  const executionResult = await withSpinner(
    async () => {
      // Dynamic import to avoid circular dependency
      const Aggo = await import('aggo');
      return Aggo.default.aggregate(documents, generationResult.pipeline);
    },
    SPINNER_PHASES.EXECUTION,
    { successMessage: '✅ Query executed successfully' }
  );

  return {
    ...generationResult,
    schema,
    samples,
    results: executionResult,
    performance: {
      schemaInferenceMs: 0, // These will be calculated by the calling function
      pipelineGenerationMs: 0,
      executionMs: 0,
    },
  };
}

async function readInputDocuments(options: CLIOptions): Promise<Document[]> {
  if (options.file) {
    return withSpinner(
      () => readJSONLFromFile(options.file!),
      'Loading data from file',
      { successMessage: '✅ Data loaded successfully' }
    );
  } else {
    // Check if stdin has data
    if (process.stdin.isTTY) {
      console.error(
        '❌ Error: No input data. Use --file or pipe data via stdin.'
      );
      console.error(
        'Example: cat data.jsonl | aggo ai "sum revenue by category"'
      );
      process.exit(1);
    }
    return withSpinner(() => readJSONLFromStdin(), 'Reading data from stdin', {
      successMessage: '✅ Data loaded successfully',
    });
  }
}

async function readJSONLFromStdin(): Promise<Document[]> {
  const documents: Document[] = [];
  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    if (line.trim()) {
      try {
        documents.push(JSON.parse(line));
      } catch (_error) {
        console.error(`⚠️  Invalid JSON line: ${line}`);
      }
    }
  }

  return documents;
}

async function readJSONLFromFile(filepath: string): Promise<Document[]> {
  const documents: Document[] = [];
  const fileStream = createReadStream(filepath, { encoding: 'utf8' });
  const rl = createInterface({ input: fileStream });

  for await (const line of rl) {
    if (line.trim()) {
      try {
        documents.push(JSON.parse(line));
      } catch (_error) {
        console.error(`⚠️  Invalid JSON line: ${line}`);
      }
    }
  }

  return documents;
}

function formatOutput(result: ReadonlyArray<unknown>, pretty: boolean): string {
  if (pretty) {
    return JSON.stringify(result, null, 2);
  } else {
    return result.map(doc => JSON.stringify(doc)).join('\n');
  }
}

async function runStructuredMode(
  query: string,
  documents: Document[],
  options: CLIOptions
): Promise<void> {
  console.error('🚀 Entering structured output mode...');
  
  // Schema inference
  const schema = await withSpinner(
    () => Promise.resolve(getSchema(documents, { sampleSize: options.limitSample })),
    SPINNER_PHASES.SCHEMA_INFERENCE,
    { successMessage: '✅ Schema analyzed' }
  );

  // Create structured client
  const client = new StructuredOpenAIClient({
    apiKey: options.apiKey,
    model: options.model || 'gpt-4o-2024-08-06',
    temperature: 0.1
  });

  // Generate structured plan
  console.error('🤖 Generating structured plan...');
  const result = await withSpinner(
    () => client.generateStructuredPlan(query, schema, documents.slice(0, 3)),
    SPINNER_PHASES.OPENAI_GENERATION,
    { successMessage: '✅ Structured plan generated' }
  );

  const { plan, pipelineJson, uidsl } = result;

  // Add windowing configuration if streaming enabled
  if (options.streaming) {
    plan.w = {
      mode: 'u',
      emitMs: options.emitMs || 1000,
      maxDocs: options.maxDocs
    };
  }

  console.error(`📊 Pipeline: ${pipelineJson.slice(0, 80)}...`);
  console.error(`🎨 UI DSL: ${uidsl}`);

  if (options.showPipeline) {
    console.log('Generated Pipeline:');
    console.log(JSON.stringify(JSON.parse(pipelineJson), null, 2));
    console.log('\nGenerated UIDSL:');
    console.log(uidsl);
    return;
  }

  if (options.tui) {
    // Launch TUI
    console.error('🎨 Launching interactive TUI...');
    
    // Clear screen and hide cursor
    process.stdout.write('\x1b[2J\x1b[0;0H\x1b[?25l');
    
    try {
      renderTUIApp(plan, documents);
    } finally {
      // Restore cursor on exit
      process.stdout.write('\x1b[?25h');
    }
  } else {
    // Structured JSON output
    const output = {
      plan,
      schema,
      query,
      tokensUsed: result.tokensUsed,
      inputDocuments: documents.length
    };

    console.log(JSON.stringify(output, null, options.pretty ? 2 : undefined));
  }
}

// Handle uncaught errors gracefully
process.on('uncaughtException', error => {
  if (error.message.includes('OPENAI_API_KEY')) {
    console.error('❌ Error: OpenAI API key is required');
    console.error(
      '💡 Set OPENAI_API_KEY environment variable or use --api-key option'
    );
  } else if (error.message.includes('quota')) {
    console.error('❌ Error: OpenAI API quota exceeded');
    console.error('💡 Check your OpenAI account usage and billing');
  } else if (
    error.message.includes('network') ||
    error.message.includes('fetch')
  ) {
    console.error('❌ Error: Network connection failed');
    console.error('💡 Check your internet connection and try again');
  } else {
    console.error(`❌ Unexpected error: ${error.message}`);
  }
  process.exit(1);
});

program.parse();
