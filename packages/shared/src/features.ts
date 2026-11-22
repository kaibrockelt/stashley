// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Features that exist in the data model but are not offered yet. The MCP server follows
 * after the MVP (D17): until then its table access flags, exclusions and page setting are
 * stored and kept, but their controls are hidden.
 */
export const features: { readonly mcp: boolean } = { mcp: false }
