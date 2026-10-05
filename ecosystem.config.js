module.exports = {
  apps: [
    {
      name: 'psw-status-monitor',
      script: './src/index.js',
      cwd: __dirname,
      // Deve rodar em uma única instância: mais instâncias duplicariam as verificações.
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '200M',
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
