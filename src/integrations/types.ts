export interface InstallOptions {
  baseUrl: string
  global?: boolean
}

export interface InstallResult {
  configPath: string
  existed: boolean
}

export interface Integration {
  id: string
  label: string
  helpText: string
  detect(): boolean
  getConfigPath(projectDir: string, opts: Pick<InstallOptions, "global">): string
  hasEntry(projectDir: string, opts: Pick<InstallOptions, "global">): boolean
  install(projectDir: string, opts: InstallOptions): InstallResult
}
