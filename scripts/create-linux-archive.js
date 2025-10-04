#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Читаем версию из package.json
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const version = packageJson.version;

console.log(`📦 Creating Linux archive for version ${version}...`);

const distPath = path.join(process.cwd(), 'dist');
const linuxUnpackedPath = path.join(distPath, 'linux-unpacked');
const archiveName = `xexamai-${version}-linux-x64.tar.gz`;
const archivePath = path.join(distPath, archiveName);

// Проверяем, существует ли папка linux-unpacked
if (!fs.existsSync(linuxUnpackedPath)) {
  console.error('❌ linux-unpacked directory not found!');
  console.error('   Make sure you ran "npm run build:linux" first');
  process.exit(1);
}

try {
  // Создаем архив
  console.log(`🔨 Creating archive: ${archiveName}`);
  execSync(`tar -czf "${archivePath}" linux-unpacked`, { 
    cwd: distPath,
    stdio: 'inherit' 
  });
  
  // Получаем размер архива
  const stats = fs.statSync(archivePath);
  const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
  
  console.log(`✅ Archive created successfully!`);
  console.log(`📁 Location: dist/${archiveName}`);
  console.log(`📊 Size: ${sizeMB} MB`);
  console.log('');
  console.log('🚀 Ready for distribution!');
  console.log('   Users can extract and run: tar -xzf xexamai-0.1.0-linux-x64.tar.gz && ./linux-unpacked/xexamai');
  
} catch (error) {
  console.error('❌ Failed to create archive:', error.message);
  process.exit(1);
}
