import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import chokidar from 'chokidar';
import debounce from 'lodash.debounce';
import { codegen } from '@graphql-codegen/core';
import * as typescriptPlugin from '@graphql-codegen/typescript';
import * as typescriptOperationsPlugin from '@graphql-codegen/typescript-operations';
import { loadDocuments, loadSchema } from 'graphql-toolkit';
import { GatsbyNode } from 'gatsby';
// @ts-ignore
import { graphql, introspectionQuery } from 'gatsby/graphql';
// @ts-ignore
import getGatsbyDependents from 'gatsby/dist/utils/gatsby-dependents';
import glob from 'glob';
import normalize from 'normalize-path';
import _ from 'lodash';

import { PluginOptions } from './types';

const resolve = (...paths: string[]) => path.resolve(process.cwd(), ...paths);
const log = (message: string) => console.log(`[gatsby-plugin-typegen] ${message}`);

const DOCUMENTS_GLOB = resolve('src/**/*.{ts,tsx}');
const DEFAULT_SCHEMA_OUTPUT_PATH = resolve('.cache/caches/gatsby-plugin-typegen/schema.json');
const DEFAULT_TYPE_DEFS_OUTPUT_PATH = resolve('node_modules/generated/types/gatsby.ts');

/**
 * (?<CallExpressionName>useStaticQuery
 *   (?<TypeTemplate><
 *     (?<TypeArgument>\S*)
 *   >)?
 * )
 * \([\s\S]*?
 * graphql
 * (?<TemplateLiteral>`\s*?
 *   (?<QueryDefinitionStart>query
 *     (?<QueryName>\S*)
 *     [^{]?\{
 *   )
 *   [^`]*?
 * `)
 */
const STATIC_QUERY_HOOK_REGEXP = /(?<CallExpressionName>useStaticQuery(?<TypeTemplate><(?<TypeArgument>\S*)>)?)\([\s\S]*?graphql(?<TemplateLiteral>`\s*?(?<QueryDefinitionStart>query (?<QueryName>\S*)[^{]{)[^`]*?`)/g
const STATIC_QUERY_HOOK_REPLACER = (substring: string, ...args: any[]): string => {
  const { length: l, [l - 1]: groups } = args;
  return substring.replace(groups['CallExpressionName'], `useStaticQuery<${groups['QueryName']}Query>`);
}

/**
 * (?<JsxTagOpening><StaticQuery
 *   (?<TagTypeTemplate><
 *     (?<TagTypeArgument>\S+)
 *   >)?
 * )
 * [\s\S]+?
 * query={
 * [\s\S]*?
 * graphql
 * (?<TemplateLiteral>`\s*?
 *   (?<QueryDefinitionStart>query
 *     (?<QueryName>\S*)
 *     [^{]?\{
 *   )
 *   [^`]*?
 * `)
 */
const STATIC_QUERY_COMPONENT_REGEXP = /(?<JsxTagOpening><StaticQuery(?<TagTypeTemplate><(?<TagTypeArgument>\S+)>)?)[\s\S]+?query={[\s\S]*?graphql(?<TemplateLiteral>`\s*?(?<QueryDefinitionStart>query (?<QueryName>\S*)[^{]?\{)[^`]*`)/g
const STATIC_QUERY_COMPONENT_REPLACER = (substring: string, ...args: any[]): string => {
  const { length: l, [l - 1]: groups } = args;
  return substring.replace(groups['JsxTagOpening'], `<StaticQuery<${groups['QueryName']}Query>`);
}

export const onPostBootstrap: GatsbyNode['onPostBootstrap'] = async ({ store, reporter }, options) => {
  const {
    schemaOutputPath = DEFAULT_SCHEMA_OUTPUT_PATH,
    typeDefsOutputPath = DEFAULT_TYPE_DEFS_OUTPUT_PATH,
    autoFix = true,
  } = options as PluginOptions;

  let cache = '';

  const extractSchema = async () => {
    const { schema } = store.getState();
    const { data: fullSchema } = await graphql(schema, introspectionQuery);
    const output = JSON.stringify(fullSchema, null, 2);
    const sha1sum = crypto.createHash('sha1').update(output).digest('hex');
    if (cache !== sha1sum) {
      cache = sha1sum;
      await fs.promises.writeFile(schemaOutputPath, output, 'utf-8');
      log(`Schema file extracted to ${schemaOutputPath}!`);
    }
  };

  const findFiles = async () => {
    // Copied from gatsby/packages/gatsby/src/query/query-compiler.js

    const resolveThemes = (themes = []) =>
      themes.reduce((merged, theme) => {
        // @ts-ignore
        merged.push(theme.themeDir)
        return merged
      }, []);

    // copied from export default
    const { program, themes, flattenedPlugins } = store.getState();

    const base = program.directory
    const additional = resolveThemes(
      themes.themes
        ? themes.themes
        : flattenedPlugins.map((plugin: any) => {
            return {
              themeDir: plugin.pluginFilepath,
            }
          })
    );

    const filesRegex = `*.+(t|j)s?(x)`;
    // Pattern that will be appended to searched directories.
    // It will match any .js, .jsx, .ts, and .tsx files, that are not
    // inside <searched_directory>/node_modules.
    const pathRegex = `/{${filesRegex},!(node_modules)/**/${filesRegex}}`;

    const modulesThatUseGatsby = await getGatsbyDependents();

    let files: string[] = [
      path.join(base, `src`),
      /*
      Copy note:
       this code locates the source files .cache/fragments/*.js was copied from
       the original query-compiler.js handles duplicates more gracefully, codegen generates duplicate types
      */
      // path.join(base, `.cache`, `fragments`),
      ...additional.map(additional => path.join(additional, `src`)),
      ...modulesThatUseGatsby.map((module: any) => module.path),
    ].reduce((merged, folderPath) => {
      merged.push(
        ...glob.sync(path.join(folderPath, pathRegex), {
          nodir: true,
        })
      )
      return merged
    }, []);

    files = files.filter(d => !d.match(/\.d\.ts$/));

    files = files.map(f => normalize(f));

    // We should be able to remove the following and preliminary tests do suggest
    // that they aren't needed anymore since we transpile node_modules now
    // However, there could be some cases (where a page is outside of src for example)
    // that warrant keeping this and removing later once we have more confidence (and tests)

    // Ensure all page components added as they're not necessarily in the
    // pages directory e.g. a plugin could add a page component. Plugins
    // *should* copy their components (if they add a query) to .cache so that
    // our babel plugin to remove the query on building is active.
    // Otherwise the component will throw an error in the browser of
    // "graphql is not defined".
    files = files.concat(
      Array.from(store.getState().components.keys(), (c: string) =>
        normalize(c)
      )
    );

    files = _.uniq(files);
    return files;
  };

  // Wait for first extraction
  const docLookupActivity = reporter.activityTimer(
    `lookup graphql documents for type generation`,
    {
      parentSpan: {},
    }
  );
  docLookupActivity.start();
  await extractSchema();
  const files = await findFiles();
  const schemaAst = await loadSchema(schemaOutputPath);
  const documents = await loadDocuments(files);
  docLookupActivity.end();

  const config = {
    schemaAst,
    filename: typeDefsOutputPath,
    plugins: [
      { typescript: {} },
      { typescriptOperations: {} },
    ],
    pluginMap: {
      typescript: typescriptPlugin,
      typescriptOperations: typescriptOperationsPlugin,
    },
    config: {
      avoidOptionals: true,
      maybeValue: 'T',
      namingConvention: {
        enumValues: 'keep',
        transformUnderscore: false,
      },
    },
  };

  const writeTypeDefinition = debounce(async () => {
    const generateSchemaActivity = reporter.activityTimer(
      `generate graphql typescript`,
      {
        parentSpan: {},
      }
    );
    generateSchemaActivity.start();
    // @ts-ignore
    const output = await codegen({
      ...config,
      documents,
    });
    await fs.promises.mkdir(path.dirname(typeDefsOutputPath), { recursive: true });
    await fs.promises.writeFile(typeDefsOutputPath, output, 'utf-8');
    generateSchemaActivity.end();
    log(`Type definitions are generated into ${typeDefsOutputPath}`);
  }, 1000);

  const fixDocuments = async (filePath: string) => {
    const code = await fs.promises.readFile(filePath, 'utf-8');
    const fixed = code
      .replace(STATIC_QUERY_HOOK_REGEXP, STATIC_QUERY_HOOK_REPLACER)
      .replace(STATIC_QUERY_COMPONENT_REGEXP, STATIC_QUERY_COMPONENT_REPLACER);

    if (code !== fixed) {
      fs.promises.writeFile(filePath, fixed, 'utf-8');
    }
  };

  const onWatch = async (filePath: string) => {
    const changed = documents.findIndex(document => document.filePath === filePath)
    if (changed !== -1) {
      documents[changed] = (await loadDocuments(filePath))[0];
    }
    writeTypeDefinition();

    if (autoFix && filePath !== schemaOutputPath) {
      fixDocuments(filePath);
    }
  };

  const watcher = chokidar.watch([
    schemaOutputPath,
    DOCUMENTS_GLOB,
  ]);

  watcher
    .on('add', onWatch)
    .on('change', onWatch)
  ;

  store.subscribe(extractSchema);
};
