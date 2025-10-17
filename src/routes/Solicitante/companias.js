// routes/compañias.js
import express from "express";
import pool from "../../config/db.js";// Ajusta según tu configuración de DB

const router = express.Router();

// GET - Obtener todas las compañías
router.get('/', async (req, res) => {
    try {
        const query = `
            SELECT id_compania, codigo_compania, nombre_compania, estado_registro, fecha_creacion
            FROM doa2.companias 
            WHERE estado_registro = 'A'
            ORDER BY nombre_compania;
        `;
        const result = await pool.query(query);
        res.json({
            success: true,
            data: result.rows,
            message: 'Compañías obtenidas exitosamente'
        });
    } catch (error) {
        console.error('Error obteniendo compañías:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor'
        });
    }
});

// GET - Obtener compañía por ID
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const query = `
            SELECT id_compania, codigo_compania, nombre_compania, estado_registro, fecha_creacion
            FROM doa2.companias 
            WHERE id_compania = $1 AND estado_registro = 'A';
        `;
        const result = await pool.query(query, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Compañía no encontrada'
            });
        }

        res.json({
            success: true,
            data: result.rows[0],
            message: 'Compañía obtenida exitosamente'
        });
    } catch (error) {
        console.error('Error obteniendo compañía:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor'
        });
    }
});

// POST - Crear nueva compañía
router.post('/', async (req, res) => {
    try {
        const { codigo_compania, nombre_compania, usuario_creador } = req.body;

        // Validaciones básicas
        if (!codigo_compania || !nombre_compania) {
            return res.status(400).json({
                success: false,
                message: 'Código y nombre de compañía son obligatorios'
            });
        }

        const query = `
            INSERT INTO doa2.companias (codigo_compania, nombre_compania, usuario_creador)
            VALUES ($1, $2, $3)
            RETURNING id_compania, codigo_compania, nombre_compania, estado_registro, fecha_creacion;
        `;
        const values = [codigo_compania, nombre_compania, usuario_creador || 'SISTEMA'];
        
        const result = await pool.query(query, values);

        res.status(201).json({
            success: true,
            data: result.rows[0],
            message: 'Compañía creada exitosamente'
        });
    } catch (error) {
        console.error('Error creando compañía:', error);
        
        if (error.code === '23505') { // Violación de unique constraint
            return res.status(400).json({
                success: false,
                message: 'El código o nombre de compañía ya existe'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Error interno del servidor'
        });
    }
});

// PUT - Actualizar compañía
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { codigo_compania, nombre_compania, estado_registro } = req.body;

        const query = `
            UPDATE doa2.companias 
            SET codigo_compania = $1, 
                nombre_compania = $2, 
                estado_registro = $3,
                fecha_modificacion = CURRENT_TIMESTAMP
            WHERE id_compania = $4
            RETURNING id_compania, codigo_compania, nombre_compania, estado_registro, fecha_creacion;
        `;
        const values = [codigo_compania, nombre_compania, estado_registro || 'A', id];
        
        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Compañía no encontrada'
            });
        }

        res.json({
            success: true,
            data: result.rows[0],
            message: 'Compañía actualizada exitosamente'
        });
    } catch (error) {
        console.error('Error actualizando compañía:', error);
        
        if (error.code === '23505') {
            return res.status(400).json({
                success: false,
                message: 'El código o nombre de compañía ya existe'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Error interno del servidor'
        });
    }
});

// DELETE - Eliminar compañía (eliminación lógica)
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const query = `
            UPDATE doa2.companias 
            SET estado_registro = 'I',
                fecha_modificacion = CURRENT_TIMESTAMP
            WHERE id_compania = $1
            RETURNING id_compania, codigo_compania, nombre_compania;
        `;
        
        const result = await pool.query(query, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Compañía no encontrada'
            });
        }

        res.json({
            success: true,
            data: result.rows[0],
            message: 'Compañía eliminada exitosamente'
        });
    } catch (error) {
        console.error('Error eliminando compañía:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor'
        });
    }
});

// GET - Obtener compañías para dropdown (solo código y nombre)
router.get('/dropdown/list', async (req, res) => {
    try {
        const query = `
            SELECT codigo_compania as value, nombre_compania as label
            FROM doa2.companias 
            WHERE estado_registro = 'A'
            ORDER BY nombre_compania;
        `;
        const result = await pool.query(query);
        res.json({
            success: true,
            data: result.rows,
            message: 'Compañías para dropdown obtenidas exitosamente'
        });
    } catch (error) {
        console.error('Error obteniendo compañías para dropdown:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor'
        });
    }
});

export default router;