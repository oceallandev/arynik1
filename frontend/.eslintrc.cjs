module.exports = {
    root: true,
    env: {
        browser: true,
        node: true,
        es2022: true,
    },
    parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
            jsx: true,
        },
    },
    ignorePatterns: ['dist', 'node_modules'],
    plugins: ['react-hooks'],
    rules: {},
};
