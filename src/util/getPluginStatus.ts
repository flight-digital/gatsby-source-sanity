import {SourceNodesArgs} from 'gatsby'
import {PluginConfig} from './validateConfig'

export default function getPluginStatus(args: SourceNodesArgs) {
  return args.store.getState().status.plugins?.[`gatsby-source-sanity`]
}

const BUILDS_KEY = 'builds'

type BuildConfig = Pick<PluginConfig, 'projectId' | 'dataset' | 'overlayDrafts'>

type BuildStatus = {
  lastBuildTime: string
  overlayDrafts: boolean
}

function getBuildKey(config: BuildConfig) {
  return `${config.projectId}-${config.dataset}`
}

/**
 * Returns the time of the last build for this project/dataset, but only if that build ran with the
 * same `overlayDrafts` setting. Nodes cached by a build in the other mode hold the other mode's
 * content (e.g. drafts from a preview build), so they must not be reused by an incremental build.
 */
export function getLastBuildTime(args: SourceNodesArgs, config: BuildConfig): Date | undefined {
  const build: BuildStatus | undefined = getPluginStatus(args)?.[BUILDS_KEY]?.[getBuildKey(config)]
  if (!build || build.overlayDrafts !== Boolean(config.overlayDrafts)) {
    return undefined
  }

  const lastBuildTime = new Date(build.lastBuildTime)
  return isNaN(lastBuildTime.getTime()) ? undefined : lastBuildTime
}

export async function registerBuildTime(args: SourceNodesArgs, config: BuildConfig) {
  const status = getPluginStatus(args) || {}
  const build: BuildStatus = {
    lastBuildTime: new Date().toISOString(),
    overlayDrafts: Boolean(config.overlayDrafts),
  }
  args.actions.setPluginStatus({
    ...status,
    [BUILDS_KEY]: {
      ...(status[BUILDS_KEY] || {}),
      [getBuildKey(config)]: build,
    },
  })
}
