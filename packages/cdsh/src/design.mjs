// CDSH compatibility layer for DSH 0.2.x.
//
// Regional token CSS is emitted by runtime.mjs/generate-regions.mjs. Host chat,
// sidebar, composer and overlay geometry remain under DSH ownership. The one
// deliberate native-surface adapter is toolMotionCss: it is scoped to the
// current 0.2.x grouped-process content node and never targets the outer chat.
import { workspaceCss } from './workspace-style.mjs'
import { enhancementCss } from './enhancements.mjs'
import { toolMotionCss } from './tool-motion.mjs'

function toolCardsEnabled(state) {
  return !(state && state.regions && state.regions.toolCards && state.regions.toolCards.enabled === false)
}

export function designCss(state) {
  return workspaceCss + '\n' + enhancementCss + (toolCardsEnabled(state) ? '\n' + toolMotionCss : '')
}

export const DESIGN_CSS_LENGTH = workspaceCss.length + enhancementCss.length + toolMotionCss.length
