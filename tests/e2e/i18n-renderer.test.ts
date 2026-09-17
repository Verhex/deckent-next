import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
describe('K2 renderer import proof', () => {
  it('loads the built translation unit synchronously without Node globals or built-in modules in its sandbox', async () => {
    const entry = new URL('../../dist/platform/core/i18n/index.js', import.meta.url).href;
    const script = `
      import vm from 'node:vm';
      import {readFile} from 'node:fs/promises';
      const context=vm.createContext({}); const modules=new Map();
      const manifest=JSON.parse(await readFile(new URL(${JSON.stringify(new URL('../../package.json', import.meta.url).href)}),'utf8'));
      const packageRoot=new URL('.',${JSON.stringify(new URL('../../package.json', import.meta.url).href)});
      async function load(url) {
        if(modules.has(url))return modules.get(url);
        const text=await readFile(new URL(url),'utf8');
        const m=url.endsWith('.json')
          ? new vm.SyntheticModule(['default'],function(){this.setExport('default',JSON.parse(text));},{context,identifier:url})
          : new vm.SourceTextModule(text,{context,identifier:url});
        modules.set(url,m); return m;
      }
      const entry=await load(${JSON.stringify(entry)});
      await entry.link((specifier,parent)=>{
        if(specifier.startsWith('.'))return load(new URL(specifier,parent.identifier).href);
        for(const [pattern,target] of Object.entries(manifest.imports ?? {})){
          const [prefix,suffix]=pattern.split('*');
          if(specifier.startsWith(prefix)&&specifier.endsWith(suffix ?? '')){
            const segment=specifier.slice(prefix.length,suffix ? -suffix.length : undefined);
            return load(new URL(target.replace('*',segment),packageRoot).href);
          }
        }
        throw new Error('Forbidden renderer dependency: '+specifier);
      });
      await entry.evaluate();
      const api=entry.namespace;
      process.stdout.write(JSON.stringify({locale:api.resolveLocale(),tr:api.t('cli.unknownCommand',{command:'x',name:'deckent'},'tr'),
        floor:api.MESSAGE_REGISTRY.defaultParams['error.node_version_low'].floor,unknown:api.t('absent',{},'tr')}));
    `;
    const result = await exec(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script], { timeout: 10_000 });
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { engines: { node: string } };
    expect(JSON.parse(result.stdout)).toMatchObject({ locale: 'en', unknown: 'absent', tr: expect.stringContaining('Bilinmeyen komut'), floor: manifest.engines.node });
  });
});
