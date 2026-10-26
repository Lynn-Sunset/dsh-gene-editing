// Local UI smoke-test data only: publishes one human message, never wakes a model.
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { fileURLToPath } from 'node:url';
export const inject = ['agents', 'workspaceRegistry'];
export async function apply(ctx) {
  const workspace = await ctx.workspaceRegistry.create(fileURLToPath(new URL('../', import.meta.url)), 'Gene smoke fixture');
  const seen = new Set();
  const publish = async agent => {
    if (agent.id !== 'gene-smoke' || seen.has(agent.id)) return;
    seen.add(agent.id);
    await workspace.attachSession(agent.id);
    if (agent.session.deriveMessages().some(m => m.role === 'user')) return;
    agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Gene Editing UI smoke test. No model request has been made.' }] }), { surfaceOp: 'append' });
  };
  ctx.on('agent/created', ({ agent }) => publish(agent));
  for (const agent of ctx.agents.list()) await publish(agent);
}
