module.exports = {
  authKeyFile: '.auth-key.json',
  functionName: 'yandex-cloud-fn-internals',
  deploy: {
    files: [ 'package*.json', 'dist/**/*.{js,json}' ],
    handler: 'dist/index.handler',
    runtime: 'nodejs14',
    timeout: 5,
    memory: 128,
    environment: {
      NODE_ENV: 'production',
    },
  }
};
