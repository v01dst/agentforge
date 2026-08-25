import React from 'react';
import { Box, Text } from 'ink';

/**
 * Dependency-free markdown-ish renderer for chat responses.
 * Handles the common cases: inline code, bold, headings, bullets,
 * and fenced code blocks. Anything else passes through as plain text.
 */

type Segment = { text: string; kind: 'plain' | 'code' | 'bold' };

/** Parse inline formatting (code spans + bold) into styled segments. */
export function parseInline(line: string): Segment[] {
  const segments: Segment[] = [];
  // Match `code` or **bold** tokens; scan left to right.
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: line.slice(lastIndex, match.index), kind: 'plain' });
    }
    if (match[1]) {
      segments.push({ text: match[1].slice(1, -1), kind: 'code' });
    } else if (match[2]) {
      segments.push({ text: match[2].slice(2, -2), kind: 'bold' });
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < line.length) {
    segments.push({ text: line.slice(lastIndex), kind: 'plain' });
  }
  return segments.length ? segments : [{ text: '', kind: 'plain' }];
}

function InlineText({ line }: { line: string }): React.ReactElement {
  const segments = parseInline(line);
  return (
    <Text>
      {segments.map((segment, index) => {
        if (segment.kind === 'code') return <Text key={index} color="cyan">{segment.text}</Text>;
        if (segment.kind === 'bold') return <Text key={index} bold>{segment.text}</Text>;
        return <Text key={index}>{segment.text}</Text>;
      })}
    </Text>
  );
}

const HEADING_PATTERN = /^(#{1,4})\s+(.*)$/;

/**
 * Render markdown-ish text for the terminal. Streaming-safe: the full
 * accumulated text is re-parsed on every render (cheap at chat sizes).
 */
export function MarkdownText({ text }: { text: string }): React.ReactElement {
  const lines = text.split('\n');
  const output: React.ReactElement[] = [];
  let inFence = false;

  lines.forEach((line, index) => {
    const fenceMatch = /^```/.test(line);
    if (fenceMatch) {
      inFence = !inFence;
      // Show a subtle delimiter for the closing fence only.
      if (!inFence && index > 0) {
        output.push(<Text key={index} dimColor>╶───</Text>);
      }
      return;
    }
    if (inFence) {
      output.push(<Text key={index} dimColor>│ {line}</Text>);
      return;
    }
    const heading = HEADING_PATTERN.exec(line);
    if (heading) {
      output.push(
        <Text key={index} bold color="yellow">
          {'#'.repeat(0)}{heading[2]}
        </Text>,
      );
      return;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      output.push(
        <Text key={index}>
          <Text color="cyan">• </Text>
          <InlineText line={bullet[1] ?? ''} />
        </Text>,
      );
      return;
    }
    output.push(<InlineText key={index} line={line} />);
  });

  return (
    <Box flexDirection="column">
      {output}
    </Box>
  );
}
