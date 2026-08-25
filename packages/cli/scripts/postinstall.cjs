#!/usr/bin/env node
/**
 * Lightweight postinstall notice. No network, no setup work — just a short
 * branded confirmation so users know the install succeeded and what to run.
 */
const cyan = (value) => process.stdout.isTTY && !process.env.NO_COLOR ? `\u001b[36m${value}\u001b[0m` : value;
const bold = (value) => process.stdout.isTTY && !process.env.NO_COLOR ? `\u001b[1m${value}\u001b[0m` : value;
const dim = (value) => process.stdout.isTTY && !process.env.NO_COLOR ? `\u001b[2m${value}\u001b[0m` : value;

let version = '';
try { version = require('./package.json').version; } catch { /* non-fatal */ }

process.stdout.write(`
${cyan('◆')} ${bold(`AgentForge v${version}`)} installed.
${dim('Run')} ${bold('agentforge')} ${dim('to start the interactive session.')}

`);
