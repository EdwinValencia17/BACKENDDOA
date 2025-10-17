// generate-hash.js
import bcrypt from 'bcryptjs';

async function generateRealHash() {
  try {
    const password = 'admin17';
    
    console.log('🔑 Generando hash REAL para:', password);
    
    // Generar hash REAL
    const realHash = await bcrypt.hash(password, 10);
    console.log('✅ Hash REAL generado:');
    console.log(realHash);
    
    // Verificar que funciona
    const isValid = await bcrypt.compare(password, realHash);
    console.log('✔️ Verificación exitosa:', isValid);
    
    // Copia este hash para la base de datos
    console.log('\n📋 Copia este hash y ejecuta en PostgreSQL:');
    console.log(`
UPDATE doa2.usuario_cuenta 
SET password_hash = '${realHash}',
    intentos_fallidos = 0,
    bloqueado_hasta = NULL,
    actualizado_en = NOW()
WHERE global_id = 'admin01';
    `);
    
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

generateRealHash();