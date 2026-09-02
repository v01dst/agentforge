import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { EzStart } from '../shell/EzStart.js';
import { colors } from '../shell/theme.js';

/**
 * /connect (0.9/1.0): the full provider catalog — all built-in presets,
 * custom endpoints (base URL + key + model id), masked key entry, and live
 * model listing from the provider's endpoint. Reuses the EzStart flow so
 * first-run and /connect are the same experience.
 */
export function ConnectWizard({ onBack }: { onBack?: () => void }): React.ReactElement {
  const [connected, setConnected] = useState<{ name: string; model: string } | undefined>(undefined);
  if (connected) {
    return (
      <Box flexDirection="column" paddingX={1} paddingTop={1}>
        <Text color={colors.uiOk}>✓ 𓋴 {connected.name} connected ({connected.model})</Text>
        <Text dimColor>  press Esc to return to the conversation — the model is active for this session.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      <EzStart
        onComplete={(result) => setConnected(result)}
        onSkip={() => onBack?.()}
      />
      <Text dimColor>  esc back to chat</Text>
    </Box>
  );
}
