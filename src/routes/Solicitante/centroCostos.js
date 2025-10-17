import pool from "../../config/db.js"; // Ajusta según tu configuración de DB
import express from "express";

const router = express.Router();

// GET - Obtener todos los centros de costo
export const getAllCentrosCosto = async (req, res) => {
  try {
    const query = `
      SELECT id_ceco, descripcion, fecha_creacion, oper_creador, 
             fecha_modificacion, oper_modifica, estado_registro, codigo
      FROM doa2.centro_costo
      WHERE estado_registro = 'A'
      ORDER BY id_ceco
    `;
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// GET - Obtener centro de costo por ID
export const getCentroCostoById = async (req, res) => {
  try {
    const { id } = req.params;
    const query = `
      SELECT id_ceco, descripcion, fecha_creacion, oper_creador, 
             fecha_modificacion, oper_modifica, estado_registro, codigo
      FROM doa2.centro_costo
      WHERE id_ceco = $1 AND estado_registro = 'A'
    `;
    
    const result = await pool.query(query, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Centro de costo no encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// POST - Crear nuevo centro de costo
export const createCentroCosto = async (req, res) => {
  try {
    const { descripcion, codigo, oper_creador } = req.body;
    
    const query = `
      INSERT INTO doa2.centro_costo 
        (descripcion, codigo, oper_creador, fecha_creacion, estado_registro)
      VALUES ($1, $2, $3, NOW(), 'A')
      RETURNING id_ceco, descripcion, fecha_creacion, oper_creador, 
                fecha_modificacion, oper_modifica, estado_registro, codigo
    `;
    
    const result = await pool.query(query, [descripcion, codigo, oper_creador]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// PUT - Actualizar centro de costo
export const updateCentroCosto = async (req, res) => {
  try {
    const { id } = req.params;
    const { descripcion, codigo, oper_modifica } = req.body;
    
    const query = `
      UPDATE doa2.centro_costo 
      SET descripcion = $1, 
          codigo = $2, 
          oper_modifica = $3, 
          fecha_modificacion = NOW()
      WHERE id_ceco = $4 AND estado_registro = 'A'
      RETURNING id_ceco, descripcion, fecha_creacion, oper_creador, 
                fecha_modificacion, oper_modifica, estado_registro, codigo
    `;
    
    const result = await pool.query(query, [descripcion, codigo, oper_modifica, id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Centro de costo no encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// DELETE - Eliminar centro de costo (soft delete)
export const deleteCentroCosto = async (req, res) => {
  try {
    const { id } = req.params;
    const { oper_modifica } = req.body;
    
    const query = `
      UPDATE doa2.centro_costo 
      SET estado_registro = 'I', 
          oper_modifica = $1, 
          fecha_modificacion = NOW()
      WHERE id_ceco = $2
      RETURNING id_ceco, estado_registro
    `;
    
    const result = await pool.query(query, [oper_modifica, id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Centro de costo no encontrado' });
    }
    
    res.json({ message: 'Centro de costo eliminado correctamente' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// GET - Buscar centros de costo por descripción o código
export const searchCentrosCosto = async (req, res) => {
  try {
    const { search } = req.query;
    
    const query = `
      SELECT id_ceco, descripcion, fecha_creacion, oper_creador, 
             fecha_modificacion, oper_modifica, estado_registro, codigo
      FROM doa2.centro_costo
      WHERE estado_registro = 'A'
        AND (descripcion ILIKE $1 OR codigo ILIKE $1)
      ORDER BY id_ceco
    `;
    
    const result = await pool.query(query, [`%${search}%`]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Rutas
router.get('/', getAllCentrosCosto);
router.get('/search', searchCentrosCosto);
router.get('/:id', getCentroCostoById);
router.post('/', createCentroCosto);
router.put('/:id', updateCentroCosto);
router.delete('/:id', deleteCentroCosto);

export default router;