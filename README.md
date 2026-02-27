# @nous-labs/context-gc

Context garbage collection for AI conversations. Tiered message compression, token budget control, and brain-backed recall hints. Manages context window pressure by progressively compressing older conversation turns.

## Overview

This package implements a virtual memory-inspired approach to context management. Messages move through tiers based on age and importance: hot (recent), warm (compressed tools), cold (summarized responses), and gone (removed with recall hints). This prevents context window exhaustion while preserving the ability to recall important information.

## Installation

Clone the repository:

```bash
git clone https://github.com/nous-labs/context-gc.git
```

Add as a local dependency in your project's `package.json`. Note: the local directory may be named `nous-context-gc` but the cloned repo will be `context-gc`.

```json
{
  "dependencies": {
    "@nous-labs/context-gc": "file:../context-gc"
  }
}
```

## Architecture

The garbage collector organizes messages into four tiers, inspired by OS virtual memory:

| Tier | Description |
|------|-------------|
| **Hot** | Recent turns, untouched |
| **Warm** | Older turns, tool outputs compressed |
| **Cold** | Assistant responses summarized |
| **Gone** | Removed entirely (with optional recall hints) |

Messages flow downward through tiers during GC cycles based on age thresholds and token pressure.

## Configuration

```typescript
interface ContextGcConfig {
  tool_output_token_threshold: number  // Compress tool outputs above this size
  hot_turns: number                    // Turns to keep in hot tier
  warm_turns: number                   // Turns to keep in warm tier
  cold_turns: number                   // Turns to keep in cold tier
  gone_turns: number                   // Turns before removal
  min_hot_turns: number                // Minimum hot turns to preserve
  max_gone_per_cycle: number           // Max messages to remove per GC
  gc_trigger_pct: number               // Trigger GC at this token percentage
  gc_target_pct: number                // Target percentage after GC
  gc_cooldown_ms: number               // Minimum time between GC cycles
  brain_write_through: boolean         // Sync summaries to brain immediately
  disable_preemptive_compaction: boolean // Disable automatic GC
}
```

## API

### Core Functions

#### `compressMessages(messages, config, logger?)`

Main GC cycle. Returns compression statistics including which messages were modified.

```typescript
const stats = compressMessages(messages, config, logger);
// Returns: CompressStats with modifications array
```

#### `classifyMessages(messages, config)`

Assigns tier classifications to messages without modifying them.

#### Token Estimation

```typescript
estimateMessageTokens(message)  // Estimate tokens for a message
estimateTokens(text)            // Estimate tokens for text
```

#### Budget Calculation

```typescript
computeDynamicBudget(config, currentPct)  // Adjust budget based on pressure
```

### Tool Call Handling

```typescript
buildToolCallMap(messages)              // Map tool calls to results
enforceToolPairAtomic(modifications, map)  // Keep tool pairs together
```

### Brain Integration

Reference markers embed brain memory IDs in compressed text:

```typescript
createMarker(brainId)      // Create a reference marker
hasMarkers(text)           // Check if text contains markers
parseMarkers(text)         // Extract brain IDs from text
```

Brain ID tracking:

```typescript
storeBrainId(messageId, brainId)  // Track brain backup
getBrainId(messageId)             // Retrieve brain ID
hasBrainId(messageId)             // Check if backed up
```

Recall hints for gone-tier messages:

```typescript
collectBrainIds(messages)         // Gather all brain IDs
shouldInjectRecallHint(modifications)  // Check if hint needed
injectRecallHint(messages, brainIds)   // Add recall hint message
```

Brain prefetch:

```typescript
findRelevantBrainEntries(messages, brain)  // Find relevant entries
injectPrefetchHint(messages, entries)      // Add prefetch hint
```

### Relevance Scoring

```typescript
applyRelevancePromotions(messages, config, query)  // Promote important messages
```

### Compressors

```typescript
compressToolOutput(content, threshold)      // Compress tool output
computeAssistantModifications(messages, config)  // Summarize assistant responses
computeSystemModifications(messages, config)     // Handle system messages
```

## Usage Example

```typescript
import { compressMessages, type ContextGcConfig } from '@nous-labs/context-gc';

const config: ContextGcConfig = {
  tool_output_token_threshold: 500,
  hot_turns: 4,
  warm_turns: 8,
  cold_turns: 16,
  gone_turns: 32,
  min_hot_turns: 2,
  max_gone_per_cycle: 4,
  gc_trigger_pct: 0.75,
  gc_target_pct: 0.60,
  gc_cooldown_ms: 5000,
  brain_write_through: true,
  disable_preemptive_compaction: false
};

const messages = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Tell me about TypeScript.' },
  { role: 'assistant', content: 'TypeScript is a typed superset of JavaScript...' }
];

const stats = compressMessages(messages, config);
console.log(`Modified ${stats.modifications.length} messages`);
```

## Types

```typescript
interface GcMessageInfo {
  index: number;
  role: string;
  tier: 'hot' | 'warm' | 'cold' | 'gone';
  tokenEstimate: number;
}

interface GcPart {
  type: 'text' | 'image' | 'tool_call' | 'tool_result';
  content?: string;
  toolCallId?: string;
}

type MessageWithParts = {
  role: string;
  content: string | GcPart[];
  tool_calls?: any[];
  tool_call_id?: string;
};

interface Logger {
  debug?: (msg: string) => void;
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}
```

## Scripts

```bash
bun test        # Run test suite
bun run build   # Build TypeScript
bun run typecheck  # Type check without emitting
```

## License

MIT

## Repository

https://github.com/nous-labs/context-gc
