import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { SERVER_VERSION } from '../../src/mcp/server.js';

/**
 * Directory-package tests.
 *
 * The OpenAI plugin manifest and the listing URLs are easy to let drift out of
 * sync with the server. These tests pin the properties that cause a submission
 * to be rejected: missing required URLs, a non-HTTPS URL, a version mismatch,
 * a wrong transport, or a capability claim that contradicts the annotations.
 */

interface PluginInterface {
  displayName: string;
  shortDescription: string;
  longDescription: string;
  developerName: string;
  category: string;
  capabilities: string[];
  websiteURL: string;
  supportURL: string;
  privacyPolicyURL: string;
  termsOfServiceURL: string;
  composerIcon: string;
  logo: string;
  brandColor: string;
  defaultPrompt: string[];
}

const plugin = JSON.parse(readFileSync('openai-plugin/plugin.json', 'utf8')) as {
  $schema: string;
  name: string;
  version: string;
  description: string;
  license: string;
  extensions: { 'com.openai': { interface: PluginInterface } };
};

const mcp = JSON.parse(readFileSync('openai-plugin/mcp.json', 'utf8')) as {
  $schema: string;
  mcpServers: Record<string, { type: string; url: string; headers?: Record<string, string> }>;
};

const iface = plugin.extensions['com.openai'].interface;

describe('plugin.json', () => {
  it('declares the Agent Plugins schema', () => {
    expect(plugin.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  });

  it('carries the mandatory root fields', () => {
    expect(plugin.name).toBe('coue');
    expect(plugin.description.length).toBeGreaterThan(20);
    expect(plugin.license).toBe('Apache-2.0');
  });

  it('stays in version lockstep with the server', () => {
    expect(plugin.version).toBe(SERVER_VERSION);
  });
});

describe('listing URLs', () => {
  const required: Array<keyof PluginInterface> = [
    'websiteURL',
    'supportURL',
    'privacyPolicyURL',
    'termsOfServiceURL'
  ];

  it.each(required)('%s is present and HTTPS', (field) => {
    const value = iface[field] as string;
    expect(value, `${field} must be set`).toBeTruthy();
    expect(value.startsWith('https://'), `${field} must be HTTPS`).toBe(true);
  });

  it.each(required)('%s is within the 1024-character submission limit', (field) => {
    expect((iface[field] as string).length).toBeLessThanOrEqual(1024);
  });

  it('points the privacy, terms, and support URLs at files that exist', () => {
    expect(existsSync('docs/privacy.md')).toBe(true);
    expect(existsSync('docs/terms.md')).toBe(true);
    expect(existsSync('docs/support.md')).toBe(true);
    expect(iface.privacyPolicyURL).toContain('docs/privacy.md');
    expect(iface.termsOfServiceURL).toContain('docs/terms.md');
    expect(iface.supportURL).toContain('docs/support.md');
  });
});

describe('listing content', () => {
  it('declares read-only capability, matching the tool annotations', () => {
    expect(iface.capabilities).toEqual(['Read']);
    expect(iface.capabilities).not.toContain('Write');
  });

  it('keeps the long description within the 2000-character limit', () => {
    expect(iface.longDescription.length).toBeLessThanOrEqual(2000);
    expect(iface.longDescription.length).toBeGreaterThan(300);
  });

  it('states the score is a heuristic rather than a certification', () => {
    expect(iface.longDescription).toContain('heuristic');
    expect(iface.longDescription).toContain('not a security certification');
  });

  it('does not position the app as belonging to one assistant vendor', () => {
    const copy = `${iface.shortDescription} ${iface.longDescription} ${plugin.description}`;
    expect(copy).not.toMatch(/for Claude|for ChatGPT|for OpenAI|for Anthropic/i);
  });

  it('references assets that exist in the package', () => {
    for (const path of [iface.composerIcon, iface.logo]) {
      expect(path.startsWith('./')).toBe(true);
      expect(existsSync(`openai-plugin/${path.slice(2)}`), path).toBe(true);
    }
  });

  it('uses the COUE brand orange', () => {
    expect(iface.brandColor).toBe('#FF7A00');
  });

  it('supplies starter prompts that match the tools on offer', () => {
    expect(iface.defaultPrompt.length).toBeGreaterThanOrEqual(3);
    for (const prompt of iface.defaultPrompt) {
      expect(prompt.length).toBeGreaterThan(10);
    }
  });
});

describe('mcp.json', () => {
  it('declares the Agent Plugins MCP schema', () => {
    expect(mcp.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  });

  it('declares exactly one remote server over Streamable HTTP', () => {
    const servers = Object.entries(mcp.mcpServers);
    expect(servers).toHaveLength(1);
    const [name, config] = servers[0] as [string, { type: string; url: string }];
    expect(name).toBe('coue');
    expect(config.type).toBe('streamable-http');
    expect(config.url.startsWith('https://')).toBe(true);
    expect(config.url.endsWith('/mcp')).toBe(true);
  });

  it('carries no credentials in the package', () => {
    for (const config of Object.values(mcp.mcpServers)) {
      expect(config.headers).toBeUndefined();
    }
    expect(JSON.stringify(mcp)).not.toMatch(/token|secret|api[_-]?key|authorization/i);
  });
});
