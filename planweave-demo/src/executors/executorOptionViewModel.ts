export function executorOptionName(name: string, _literalNames?: readonly string[]) {
  return name;
}

export function buildExecutorOptionViews({ currentExecutorNames = [], executorOptions, literalExecutorNames = [] }: {
  currentExecutorNames?: readonly string[];
  executorOptions: readonly string[];
  literalExecutorNames?: readonly string[];
}) {
  return [...new Set([...executorOptions, ...currentExecutorNames])].map((name) => ({
    name, label: name, disabled: false, custom: literalExecutorNames.includes(name)
  }));
}
