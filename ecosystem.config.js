// Load environment variables from .env file
require('dotenv').config({ path: '/var/www/kanban-v2/.env' });

module.exports = {
  apps: [
    {
      name: 'kanban-v2',
      script: 'npm',
      args: 'start',
      cwd: '/var/www/kanban-v2',
      env: {
        NODE_ENV: 'production',
        PORT: '3555',
        // Database
        DATABASE_URL: process.env.DATABASE_URL,
        // NextAuth
        NEXTAUTH_URL: process.env.NEXTAUTH_URL,
        NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
        // Email/SMTP
        EMAIL_FROM: process.env.EMAIL_FROM,
        SMTP_HOST: process.env.SMTP_HOST,
        SMTP_PORT: process.env.SMTP_PORT,
        SMTP_SECURE: process.env.SMTP_SECURE,
        SMTP_USER: process.env.SMTP_USER,
        SMTP_PASS: process.env.SMTP_PASS,
        // App
        APP_URL: process.env.APP_URL,
        // S3 (if needed)
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
        AWS_S3_BUCKET: process.env.AWS_S3_BUCKET,
        AWS_S3_REGION: process.env.AWS_S3_REGION,
        // Superadmin
        SUPERADMIN_EMAIL: process.env.SUPERADMIN_EMAIL,
      },
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G'
    },
    {
      name: 'kanban-v2-socket',
      script: 'npx',
      args: 'tsx src/socket/server.ts',
      cwd: '/var/www/kanban-v2',
      env: {
        NODE_ENV: 'production',
        SOCKET_PORT: '3556',
        // Database
        DATABASE_URL: process.env.DATABASE_URL,
        // NextAuth
        NEXTAUTH_URL: process.env.NEXTAUTH_URL,
        NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
        // App
        APP_URL: process.env.APP_URL,
      },
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M'
    }
  ]
};
