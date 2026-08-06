const Card = require('../models/Card');
const {
  maskCardFieldsInObject,
  maskCardFieldsInList,
} = require('../utils/maskCardNumber');

/** Accept snake_case (API docs) or camelCase (frontend) in POST/PUT body. */
function normalizeCardBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const issuing_bank =
    b.issuing_bank !== undefined ? b.issuing_bank : b.issuingBank;
  const card_holder =
    b.card_holder !== undefined ? b.card_holder : b.cardHolder;
  const card_number =
    b.card_number !== undefined ? b.card_number : b.cardNumber;
  const expiry_date =
    b.expiry_date !== undefined ? b.expiry_date : b.expiryDate;
  let credit_limit =
    b.credit_limit !== undefined ? b.credit_limit : b.creditLimit;
  if (credit_limit === undefined && b.amountLimit !== undefined) {
    credit_limit = b.amountLimit;
  }
  const billing_cycle_days =
    b.billing_cycle_days !== undefined
      ? b.billing_cycle_days
      : b.billingCycleDays;
  const is_active = b.is_active !== undefined ? b.is_active : b.isActive;
  return {
    issuing_bank,
    card_holder,
    card_number,
    expiry_date,
    credit_limit,
    billing_cycle_days,
    is_active,
  };
}

class CardController {
  // GET /api/cards - List all cards (both active and inactive by default)
  static async listCards(req, res) {
    try {
      const { active_only, include_inactive } = req.query;
      // active_only=true → active only (wins over include_inactive)
      // include_inactive=false → active only (per API docs)
      // include_inactive=true → include inactive
      // Default: include inactive (show all)
      let showActiveOnly = false;
      if (active_only === 'true' || active_only === '1') {
        showActiveOnly = true;
      } else if (include_inactive === 'false' || include_inactive === '0') {
        showActiveOnly = true;
      } else if (include_inactive === 'true' || include_inactive === '1') {
        showActiveOnly = false;
      }
      const includeInactive = !showActiveOnly;

      const cards = await Card.getAll(includeInactive);

      res.json({
        success: true,
        data: maskCardFieldsInList(cards),
        count: cards.length
      });
    } catch (error) {
      console.error('Error listing cards:', error);
      console.error('Error details:', error.message, error.stack);
      const hint = error.sqlMessage || error.message;
      res.status(500).json({
        success: false,
        error: 'Failed to fetch credit cards',
        details: hint,
        code: error.code
      });
    }
  }

  // POST /api/cards - Create new card
  static async createCard(req, res) {
    try {
      const {
        issuing_bank,
        card_holder,
        card_number,
        expiry_date,
        credit_limit,
        billing_cycle_days,
        is_active,
      } = normalizeCardBody(req.body);

      // Validation
      if (!issuing_bank || !card_holder || !card_number || !expiry_date) {
        return res.status(400).json({
          success: false,
          error: 'issuing_bank, card_holder, card_number, and expiry_date are required'
        });
      }

      // Validate card_number (should be valid card number, can have spaces)
      const cleanCardNumber = card_number.replace(/\s/g, '');
      if (cleanCardNumber.length < 13 || cleanCardNumber.length > 19 || !/^\d+$/.test(cleanCardNumber)) {
        return res.status(400).json({
          success: false,
          error: 'card_number must be a valid card number (13-19 digits, spaces allowed)'
        });
      }

      // Validate expiry_date format (MMM-YY, e.g., "Feb-28")
      const expiryRegex = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2}$/i;
      if (!expiryRegex.test(expiry_date)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid expiry_date format. Expected MMM-YY (e.g., Feb-28, Dec-29)'
        });
      }

      // Validate credit_limit if provided
      if (credit_limit !== undefined) {
        const limit = parseFloat(credit_limit);
        if (isNaN(limit) || limit < 0) {
          return res.status(400).json({
            success: false,
            error: 'credit_limit must be a valid number >= 0'
          });
        }
      }

      // Validate billing_cycle_days if provided
      if (billing_cycle_days !== undefined) {
        const days = parseInt(billing_cycle_days);
        if (isNaN(days) || days < 1 || days > 365) {
          return res.status(400).json({
            success: false,
            error: 'billing_cycle_days must be a valid integer between 1 and 365'
          });
        }
      }

      const card = await Card.create({
        issuingBank: issuing_bank.trim(),
        cardHolder: card_holder.trim(),
        cardNumber: card_number.trim(),
        expiryDate: expiry_date,
        creditLimit: credit_limit,
        billingCycleDays: billing_cycle_days || 25, // Default to 25 if not provided
        isActive: is_active !== undefined ? is_active : true
      });

      res.status(201).json({
        success: true,
        message: 'Credit card created successfully',
        data: maskCardFieldsInObject(card)
      });
    } catch (error) {
      console.error('Error creating card:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to create credit card'
      });
    }
  }

  // PUT /api/cards/:id - Update card
  static async updateCard(req, res) {
    try {
      const { id } = req.params;
      const {
        issuing_bank,
        card_holder,
        card_number,
        expiry_date,
        credit_limit,
        billing_cycle_days,
        is_active,
      } = normalizeCardBody(req.body);

      // Check if card exists
      const existing = await Card.getById(id);
      if (!existing) {
        return res.status(404).json({
          success: false,
          error: 'Credit card not found'
        });
      }

      // Validate card_number if provided
      if (card_number !== undefined) {
        const cleanCardNumber = card_number.replace(/\s/g, '');
        if (cleanCardNumber.length < 13 || cleanCardNumber.length > 19 || !/^\d+$/.test(cleanCardNumber)) {
          return res.status(400).json({
            success: false,
            error: 'card_number must be a valid card number (13-19 digits, spaces allowed)'
          });
        }
      }

      // Validate expiry_date if provided (MMM-YY format)
      if (expiry_date !== undefined) {
        const expiryRegex = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2}$/i;
        if (!expiryRegex.test(expiry_date)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid expiry_date format. Expected MMM-YY (e.g., Feb-28, Dec-29)'
          });
        }
      }

      // Validate credit_limit if provided
      if (credit_limit !== undefined) {
        const limit = parseFloat(credit_limit);
        if (isNaN(limit) || limit < 0) {
          return res.status(400).json({
            success: false,
            error: 'credit_limit must be a valid number >= 0'
          });
        }
      }

      // Validate billing_cycle_days if provided
      if (billing_cycle_days !== undefined) {
        const days = parseInt(billing_cycle_days);
        if (isNaN(days) || days < 1 || days > 365) {
          return res.status(400).json({
            success: false,
            error: 'billing_cycle_days must be a valid integer between 1 and 365'
          });
        }
      }

      const card = await Card.update(id, {
        issuingBank:
          typeof issuing_bank === 'string' ? issuing_bank.trim() : issuing_bank,
        cardHolder:
          typeof card_holder === 'string' ? card_holder.trim() : card_holder,
        cardNumber:
          typeof card_number === 'string' ? card_number.trim() : card_number,
        expiryDate: expiry_date,
        creditLimit: credit_limit,
        billingCycleDays: billing_cycle_days,
        isActive: is_active,
      });

      if (!card) {
        return res.status(404).json({
          success: false,
          error: 'Credit card not found'
        });
      }

      res.json({
        success: true,
        message: 'Credit card updated successfully',
        data: maskCardFieldsInObject(card)
      });
    } catch (error) {
      console.error('Error updating card:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to update credit card'
      });
    }
  }

  // DELETE /api/cards/:id - Deactivate card
  static async deleteCard(req, res) {
    try {
      const { id } = req.params;

      const card = await Card.deactivate(id);

      if (!card) {
        return res.status(404).json({
          success: false,
          error: 'Credit card not found'
        });
      }

      res.json({
        success: true,
        message: 'Credit card deactivated successfully',
        data: maskCardFieldsInObject(card)
      });
    } catch (error) {
      console.error('Error deactivating card:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to deactivate credit card'
      });
    }
  }

  // PATCH /api/cards/:id/activate - Activate card
  static async activateCard(req, res) {
    try {
      const { id } = req.params;

      const card = await Card.activate(id);

      if (!card) {
        return res.status(404).json({
          success: false,
          error: 'Credit card not found'
        });
      }

      res.json({
        success: true,
        message: 'Credit card activated successfully',
        data: maskCardFieldsInObject(card)
      });
    } catch (error) {
      console.error('Error activating card:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to activate credit card'
      });
    }
  }

  // GET /api/cards/:id - Get single card
  static async getCard(req, res) {
    try {
      const { id } = req.params;

      const card = await Card.getById(id);

      if (!card) {
        return res.status(404).json({
          success: false,
          error: 'Credit card not found'
        });
      }

      res.json({
        success: true,
        data: maskCardFieldsInObject(card)
      });
    } catch (error) {
      console.error('Error fetching card:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch credit card'
      });
    }
  }
}

module.exports = CardController;
