import {SourceNodesArgs} from 'gatsby'
import {SanityClient} from '@sanity/client'
import debug from '../debug'
import {SanityNode} from '../types/gatsby'
import {SanityWebhookBody, SanityWebhookDeleteBody} from '../types/sanity'
import {ProcessingOptions} from './normalize'
import {unprefixId, prefixId, safeId} from './documentIds'

type deleteWebhookArgs = SourceNodesArgs & {webhookBody: SanityWebhookDeleteBody}

/**
 * Gets a document id received from the webhook & delete it in the store.
 *
 * The webhook body is unauthenticated, so it is only used as a hint: the node is
 * deleted only after Sanity confirms the document no longer exists.
 */
async function handleDeleteWebhook(
  args: deleteWebhookArgs,
  options: {client: SanityClient; processingOptions: ProcessingOptions},
): Promise<boolean> {
  const {webhookBody, reporter, getNode, createNodeId, actions} = args

  const {documentId: rawId, dataset, projectId} = webhookBody

  const publishedDocumentId = unprefixId(rawId)
  const config = options.client.config()

  if (config.projectId !== projectId || config.dataset !== dataset) {
    return false
  }

  // If a draft is deleted, avoid deleting its published counterpart
  if (rawId.startsWith('drafts.') && options.processingOptions.overlayDrafts) {
    // Sub-optimal: this will skip deleting draft-only documents which should be deleted.
    return true
  }

  const nodeId = safeId(publishedDocumentId, createNodeId)
  const node = getNode(nodeId) as SanityNode | undefined
  if (!node) {
    return true
  }

  // With overlayDrafts the node may be backed by the draft, so both versions must be gone.
  const idsBackingNode = options.processingOptions.overlayDrafts
    ? [publishedDocumentId, prefixId(publishedDocumentId)]
    : [publishedDocumentId]

  let remaining: unknown[]
  try {
    remaining = (await options.client.getDocuments(idsBackingNode)).filter(Boolean)
  } catch (err) {
    reporter.warn(
      `[sanity] Could not confirm deletion of document "${publishedDocumentId}" with Sanity, skipping delete: ${
        err instanceof Error ? err.message : err
      }`,
    )
    return true
  }

  if (remaining.length > 0) {
    debug('Document %s still exists in Sanity, ignoring delete webhook', publishedDocumentId)
    return true
  }

  const current = getNode(nodeId)
  if (!current || current.internal.contentDigest !== node.internal.contentDigest) {
    debug('Node for %s changed while confirming deletion, ignoring delete webhook', nodeId)
    return true
  }

  debug('Deleted document with ID %s', node._id)
  actions.deleteNode(node)

  reporter.info(`Deleted 1 document`)
  return true
}

export async function handleWebhookEvent(
  args: SourceNodesArgs & {webhookBody?: SanityWebhookBody},
  options: {client: SanityClient; processingOptions: ProcessingOptions},
): Promise<boolean> {
  const {webhookBody, reporter} = args
  const validated = validateWebhookPayload(webhookBody)
  if (validated === false) {
    debug('[sanity] Invalid/non-sanity webhook payload received')
    return false
  }

  reporter.info('[sanity] Processing changed documents from webhook')

  if (validated === 'delete-operation') {
    return handleDeleteWebhook(args as deleteWebhookArgs, options)
  }

  return false
}

export function validateWebhookPayload(
  payload: SanityWebhookBody | undefined,
): 'delete-operation' | false {
  if (!payload) {
    return false
  }

  if (
    'operation' in payload &&
    payload.operation === 'delete' &&
    typeof payload.documentId === 'string' &&
    payload.documentId.length > 0 &&
    typeof payload.projectId === 'string' &&
    typeof payload.dataset === 'string'
  ) {
    return 'delete-operation'
  }

  return false
}
