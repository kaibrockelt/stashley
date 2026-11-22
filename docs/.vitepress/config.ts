// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitepress'

/** The documentation site (§ Dokumentation), published to GitHub Pages by docs.yml. */
export default defineConfig({
  title: 'Stashley',
  description: 'Dashboards, forms and table views on MariaDB and MySQL',
  lang: 'en',
  base: process.env.DOCS_BASE ?? '/',
  cleanUrls: true,
  // architecture.md refers to PROGRESS.md in the repository, outside the site.
  ignoreDeadLinks: [/PROGRESS/],
  lastUpdated: false,
  srcExclude: ['scripts/**', 'README.md'],
  head: [['link', { rel: 'icon', href: 'stashley-icon.svg' }]],
  themeConfig: {
    logo: '/stashley-icon.svg',
    nav: [
      { text: 'Admin guide', link: '/admin/' },
      { text: 'Manager guide', link: '/manager/' },
      { text: 'API', link: '/api/' },
      { text: 'Changelog', link: '/CHANGELOG' },
    ],
    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Demo', link: '/demo' },
        ],
      },
      {
        text: 'Admin guide',
        items: [
          { text: 'Installation', link: '/admin/' },
          { text: 'Configuration', link: '/admin/configuration' },
          { text: 'Databases and privileges', link: '/admin/databases' },
          { text: 'Sign-in and accounts', link: '/admin/accounts' },
          { text: 'Backup, upgrades and keys', link: '/admin/operations' },
          { text: 'Moving a configuration', link: '/admin/configuration-transfer' },
        ],
      },
      {
        text: 'Manager guide',
        items: [
          { text: 'Pages', link: '/manager/' },
          { text: 'Queries', link: '/manager/queries' },
          { text: 'Forms and table pages', link: '/manager/forms-and-tables' },
          { text: 'Rights', link: '/manager/rights' },
          { text: 'CSV import', link: '/manager/imports' },
        ],
      },
      {
        text: 'REST API',
        items: [
          { text: 'Tokens and conventions', link: '/api/' },
          { text: 'Reference', link: '/api/reference' },
        ],
      },
      {
        text: 'Project',
        items: [
          { text: 'Architecture', link: '/architecture' },
          { text: 'Changelog', link: '/CHANGELOG' },
        ],
      },
    ],
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/kaibrockelt/stashley' }],
    footer: { message: 'Free software under the GNU AGPL 3.0.' },
  },
})
