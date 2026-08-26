import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { subscribeApprovals, resolveToolApproval, type PendingApproval } from '../approvals.js';
import { colors } from './shell/theme.js';

/**
 * Full-screen-ish approval card rendered above the chat when a tool needs
 * permission (ask mode). Keys: y approve · n deny · a always (session) ·
 * esc deny. Renders nothing when the queue is empty.
 */
export function ApprovalCard(): React.ReactElement | null {
  const [pending, setPending] = useState<PendingApproval[]>([]);
  useEffect(() => subscribeApprovals(setPending), []);
  useInput((_value, key) => {
    const current = pending[0];
    if (!current) return;
    if (key.escape) { resolveToolApproval(current.id, { approved: false }); return; }
    const lowered = (_value ?? '').toLowerCase();
    if (lowered === 'y') resolveToolApproval(current.id, { approved: true });
    else if (lowered === 'n') resolveToolApproval(current.id, { approved: false });
    else if (lowered === 'a') resolveToolApproval(current.id, { approved: true, sessionOnly: true });
  });

  const current = pending[0];
  if (!current) return null;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.warn} paddingX={1} marginBottom={1}>
      <Text bold color={colors.warn}>{`⚠ approval required — ${current.tool}`}</Text>
      <Text>  {current.summary}</Text>
      {current.permissions.length ? <Text dimColor>  requires: {current.permissions.join(', ')}</Text> : null}
      {pending.length > 1 ? <Text dimColor>  (+{pending.length - 1} more queued)</Text> : null}
      <Text dimColor>{'[y] allow once  [a] always this session  [n/Esc] deny'}</Text>
    </Box>
  );
}

export default ApprovalCard;
