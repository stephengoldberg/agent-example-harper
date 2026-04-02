const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

const optional = (name, fallback) => process.env[name] ?? fallback

export const config = {
  anthropic: {
    apiKey: () => required('ANTHROPIC_API_KEY'),
    model: () => optional('CLAUDE_MODEL', 'claude-sonnet-4-5-20250929'),
  },
}
