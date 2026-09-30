// Offline test harness for the existing 984626a-local image. Its client Babel plugins
// were omitted from the image; this uses the same installed presets and no new dependencies.
const path = require('path');
const upstream = require('/app/client/jest.config.cjs');
module.exports = {
  ...upstream,
  rootDir: path.resolve('/app/client'),
  testEnvironment: 'jsdom',
  testEnvironmentOptions: { url: 'http://localhost:3080' },
  setupFiles: ['<rootDir>/test/polyfills.js'],
  setupFilesAfterEnv: [
    '@testing-library/jest-dom/extend-expect',
    '/h3/openschool/jest-handoff-setup.cjs',
  ],
  transform: {
    '\\.[jt]sx?$': [
      'babel-jest',
      {
        babelrc: false,
        configFile: false,
        plugins: [
          function importMetaForOfflineTests({ types }) {
            return {
              visitor: {
                MetaProperty(node) {
                  if (node.node.meta.name === 'import' && node.node.property.name === 'meta') {
                    node.replaceWith(
                      types.objectExpression([
                        types.objectProperty(
                          types.identifier('env'),
                          types.objectExpression([
                            types.objectProperty(
                              types.identifier('MODE'),
                              types.stringLiteral('test'),
                            ),
                          ]),
                        ),
                      ]),
                    );
                  }
                },
              },
            };
          },
        ],
        presets: [
          ['@babel/preset-env', { targets: { node: 'current' } }],
          ['@babel/preset-react', { runtime: 'automatic' }],
          '@babel/preset-typescript',
        ],
      },
    ],
  },
  clearMocks: true,
};
