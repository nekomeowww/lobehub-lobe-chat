import { LobeBuiltinTool } from '@lobechat/types';

import { isDesktop } from '@/const/version';

import { ArtifactsManifest } from './artifacts';
import { CodeInterpreterManifest } from './code-interpreter';
import { DalleManifest } from './dalle';
import { LocalSystemManifest } from './local-system';
import { MemoryManifest } from './memory';
import { WebBrowsingManifest } from './web-browsing';

export const builtinTools: LobeBuiltinTool[] = [
  // TODO: Migrate to the extended plugin system to configure different context engineering combinations.
  {
    identifier: ArtifactsManifest.identifier,
    manifest: ArtifactsManifest,
    type: 'builtin',
  },
  {
    identifier: DalleManifest.identifier,
    manifest: DalleManifest,
    type: 'builtin',
  },
  {
    hidden: !isDesktop,
    identifier: LocalSystemManifest.identifier,
    manifest: LocalSystemManifest,
    type: 'builtin',
  },
  {
    identifier: MemoryManifest.identifier,
    manifest: MemoryManifest,
    type: 'builtin',
  },
  {
    hidden: true,
    identifier: WebBrowsingManifest.identifier,
    manifest: WebBrowsingManifest,
    type: 'builtin',
  },
  {
    identifier: CodeInterpreterManifest.identifier,
    manifest: CodeInterpreterManifest,
    type: 'builtin',
  },
];
