const Statement = require('../models/Statement');
const Card = require('../models/Card');
const StatementService = require('../services/statementService');
const { formatAmount } = require('../utils/formatAmount');

// Helper function to format date as DD-MM-YY
const formatDateDDMMYY = (dateString) => {
  if (!dateString) return null;
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return null;
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = String(date.getFullYear()).slice(-2);
  return `${day}-${month}-${year}`;
};

// Helper function to get month abbreviation (Jan, Feb, etc.)
const getMonthAbbreviation = (dateString) => {
  if (!dateString) return null;
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return null;
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return monthNames[date.getMonth()];
};

class StatementController {
  // POST /api/statements/init/:month - Initialize statements for a month
  static async initializeStatements(req, res) {
    try {
      const { month } = req.params;
      const { statement_dates } = req.body || {};

      // Validate month format (YYYY-MM)
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid month format. Expected YYYY-MM (e.g., 2024-02)'
        });
      }

      // Validate month is a valid date
      const [year, monthNum] = month.split('-');
      const monthNumInt = parseInt(monthNum);
      const yearNum = parseInt(year);
      
      if (monthNumInt < 1 || monthNumInt > 12) {
        return res.status(400).json({
          success: false,
          error: 'Invalid month. Must be between 01 and 12'
        });
      }

      if (yearNum < 2000 || yearNum > 2100) {
        return res.status(400).json({
          success: false,
          error: 'Invalid year. Must be between 2000 and 2100'
        });
      }

      const result = await StatementService.initializeStatementsForMonth(month, statement_dates || {});

      res.json({
        success: true,
        message: `Statements initialized for ${month}`,
        data: result
      });
    } catch (error) {
      console.error('Error initializing statements:', error);
      
      if (error.message.includes('already exists')) {
        return res.status(409).json({
          success: false,
          error: error.message
        });
      }

      res.status(500).json({
        success: false,
        error: error.message || 'Failed to initialize statements'
      });
    }
  }

  // GET /api/statements/:month - List statements for a month
  // month format: YYYY-MM (e.g., 2024-02) or "all" for all statements
  // Optional query params: 
  //   - year: year in YYYY format (e.g., 2026)
  //   - months: comma-separated months in YYYY-MM format (e.g., "2024-01,2024-02,2024-03") 
  //             OR comma-separated month numbers (e.g., "1,2,3") when used with year parameter
  //   - card_id: filter by specific card
  static async listStatements(req, res) {
    try {
      const { month } = req.params;
      const { card_id, months, year } = req.query;

      // Support multiple months via query parameter
      let selectedMonths = [];
      
      // Handle year + months query parameters (e.g., ?year=2026&months=1,2,3)
      if (year && months) {
        const yearNum = parseInt(year);
        
        // Validate year
        if (isNaN(yearNum) || yearNum < 2000 || yearNum > 2100) {
          return res.status(400).json({
            success: false,
            error: 'Invalid year. Expected a number between 2000 and 2100'
          });
        }
        
        // Parse comma-separated month numbers
        const monthNumbers = months.split(',').map(m => m.trim()).filter(m => m);
        
        // Convert month numbers to YYYY-MM format
        for (const monthNumStr of monthNumbers) {
          const monthNum = parseInt(monthNumStr);
          
          // Validate month number
          if (isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
            return res.status(400).json({
              success: false,
              error: `Invalid month number: ${monthNumStr}. Expected a number between 1 and 12`
            });
          }
          
          // Convert to YYYY-MM format
          const monthStr = String(monthNum).padStart(2, '0');
          selectedMonths.push(`${yearNum}-${monthStr}`);
        }
      } else if (months) {
        // Parse comma-separated months in YYYY-MM format
        selectedMonths = months.split(',').map(m => m.trim()).filter(m => m);
        
        // Validate each month format
        for (const m of selectedMonths) {
          if (!/^\d{4}-\d{2}$/.test(m)) {
            return res.status(400).json({
              success: false,
              error: `Invalid month format: ${m}. Expected YYYY-MM (e.g., 2024-02) or use year and months parameters (e.g., ?year=2026&months=1,2,3)`
            });
          }
        }
      } else if (month) {
        // Single month from path parameter
        if (month !== 'all' && !/^\d{4}-\d{2}$/.test(month)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid month format. Expected YYYY-MM (e.g., 2024-02) or "all"'
          });
        }
        if (month !== 'all') {
          selectedMonths = [month];
        }
      }

      // If multiple months selected, fetch statements for each month
      let allStatements = [];
      
      if (selectedMonths.length > 0) {
        // Fetch statements for each selected month
        for (const selectedMonth of selectedMonths) {
          const filters = {
            month: selectedMonth,
            includeAllCards: true // Show all cards for each month, even without statements
          };
          if (card_id) {
            filters.cardId = card_id;
          }
          
          const monthStatements = await Statement.getAll(filters);
          // Tag each row with the month being processed (important for rows without statements)
          const taggedStatements = monthStatements.map(row => ({
            ...row,
            statement_month: row.statement_month || selectedMonth // Use selectedMonth if statement_month is null
          }));
          allStatements = allStatements.concat(taggedStatements);
        }
      } else if (month === 'all') {
        // Fetch all statements
        const filters = {};
        if (card_id) {
          filters.cardId = card_id;
        }
        allStatements = await Statement.getAll(filters);
      } else {
        // No month specified - return empty
        return res.status(400).json({
          success: false,
          error: 'Please specify month(s) using path parameter (:month), query parameter (months), or year and months query parameters (e.g., ?year=2026&months=1,2,3)'
        });
      }

      const statements = allStatements;

      // Format statements for display
      // If card doesn't have statement, calculate default values based on statement_month and card's billing cycle
      const formattedStatements = statements.map(row => {
        // Calculate default statement_date (first day of month) if not exists
        let defaultStatementDate = null;
        let defaultDueDate = null;
        let defaultDays = null;
        let calculatedDueMonth = row.due_month || null;
        
        // Use statement_month from row (should always be set now, even for multiple months, due to tagging above)
        const statementMonth = row.statement_month;
        
        if (statementMonth && !row.statement_date) {
          // Parse month to get year and month number
          const [year, monthNum] = statementMonth.split('-');
          const yearNum = parseInt(year);
          const monthNumInt = parseInt(monthNum);
          
          // Use card's statement_day (default to 1 if not set)
          // Convert to integer to ensure we have a number
          const statementDay = row.statement_day ? parseInt(row.statement_day) : 1;
          
          // Calculate statement_date using the card's statement_day for the selected month
          // Handle cases where statement_day might exceed days in month (use last day of month)
          const daysInMonth = new Date(yearNum, monthNumInt, 0).getDate();
          const finalStatementDay = Math.min(statementDay, daysInMonth);
          
          // Create date string directly without timezone conversion issues
          // Format: YYYY-MM-DD
          const dayStr = String(finalStatementDay).padStart(2, '0');
          const monthStr = String(monthNumInt).padStart(2, '0');
          defaultStatementDate = `${yearNum}-${monthStr}-${dayStr}`;
          
          // Calculate due_date = statement_date + billing_cycle_days
          const billingCycleDays = row.billing_cycle_days || 25;
          defaultDays = billingCycleDays;
          
          // Parse the statement date and add billing cycle days
          const stmtDate = new Date(defaultStatementDate + 'T12:00:00'); // Use noon to avoid timezone issues
          stmtDate.setDate(stmtDate.getDate() + billingCycleDays);
          
          // Format as YYYY-MM-DD without timezone conversion
          const dueYear = stmtDate.getFullYear();
          const dueMonth = String(stmtDate.getMonth() + 1).padStart(2, '0');
          const dueDay = String(stmtDate.getDate()).padStart(2, '0');
          defaultDueDate = `${dueYear}-${dueMonth}-${dueDay}`;
          
          // Calculate due_month as month abbreviation (Jan, Feb, etc.) from the calculated due_date
          calculatedDueMonth = getMonthAbbreviation(defaultDueDate);
        } else if (!calculatedDueMonth && row.due_date) {
          // Calculate due_month as month abbreviation from existing due_date if not already set
          calculatedDueMonth = getMonthAbbreviation(row.due_date);
        } else if (calculatedDueMonth) {
          // If due_month is stored as number (1-12) or "Month YYYY" format, convert to abbreviation
          if (typeof calculatedDueMonth === 'number') {
            const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                               'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            calculatedDueMonth = monthNames[calculatedDueMonth - 1] || null;
          } else if (typeof calculatedDueMonth === 'string' && calculatedDueMonth.length > 3) {
            // Try to parse "Month YYYY" or full month name
            const monthNamesFull = ['January', 'February', 'March', 'April', 'May', 'June', 
                                   'July', 'August', 'September', 'October', 'November', 'December'];
            const monthNamesShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const monthIndex = monthNamesFull.findIndex(m => calculatedDueMonth.includes(m));
            if (monthIndex !== -1) {
              calculatedDueMonth = monthNamesShort[monthIndex];
            } else if (row.due_date) {
              calculatedDueMonth = getMonthAbbreviation(row.due_date);
            }
          }
          // If already in short format (Jan, Feb, etc.), keep as is
        }
        
        // Format response to match table structure (matching image headers)
        const formatted = {
          // Card details (always present - from cards table)
          issuing_bank: row.issuing_bank || null,
          card_holder: row.card_holder || null,
          card_number: row.card_number || null,
          
          // Statement details (from statements table or calculated defaults)
          // id: statement_id if exists (for editing), otherwise null
          // card_id: always present (unique identifier for each card)
          id: row.id || null,
          card_id: row.card_id || row.credit_card_id || null, // Always present - unique card identifier
          credit_card_id: row.credit_card_id || row.card_id || null,
          statement_id: row.id || null, // Same as id (for clarity)
          statement_month: statementMonth || null, // Use statementMonth which is now always set from tagged row
          statement_date: formatDateDDMMYY(row.statement_date || defaultStatementDate),
          due_date: formatDateDDMMYY(row.due_date || defaultDueDate),
          days: row.days || defaultDays,
          due_month: calculatedDueMonth || (row.due_date ? getMonthAbbreviation(row.due_date) : null),
          total_payment_due: row.total_due ? formatAmount(row.total_due) : "0.00", // Matches "Total Payment Due"
          paid: row.paid_amount ? formatAmount(row.paid_amount) : "0.00", // Matches "Paid"
          epp: row.epp_balance ? formatAmount(row.epp_balance) : "0.00", // Matches "EPP"
          amount_pending: row.pending_amount ? formatAmount(row.pending_amount) : "0.00", // Matches "Amount Pending"
          balance_transfer: row.balance_transfer ? formatAmount(row.balance_transfer) : "0.00",
          payment_status: row.payment_status || 'PARTIAL',
          created_at: row.created_at || null,
          updated_at: row.updated_at || null
        };
        return formatted;
      });

      res.json({
        success: true,
        data: formattedStatements,
        count: formattedStatements.length,
        filters: {
          month: month || null, // Single month from path (for backward compatibility)
          months: selectedMonths.length > 0 ? selectedMonths : null, // Multiple months
          card_id: card_id || null
        }
      });
    } catch (error) {
      console.error('Error fetching statements:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch statements',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }

  // PUT/PATCH/POST /api/statements/:id - Update statement
  // Can use statement_id directly, or card_id + month query params
  // Examples:
  //   PUT/PATCH/POST /api/statements/statement-uuid
  //   PUT/PATCH/POST /api/statements/card-uuid?month=2026-01
  // Supports both field name formats:
  //   - Backend format: total_due, paid_amount, epp_balance
  //   - Frontend format: total_payment_due, paid, epp
  static async updateStatement(req, res) {
    try {
      const { id } = req.params;
      const { month } = req.query;
      const { 
        statement_date, 
        due_date,
        due_month,
        // Backend format (preferred)
        total_due, 
        paid_amount, 
        epp_balance, 
        balance_transfer,
        // Frontend format (also supported)
        total_payment_due,
        paid,
        epp
      } = req.body;
      
      // Normalize field names - support both frontend and backend formats
      const finalTotalDue = total_due !== undefined ? total_due : total_payment_due;
      const finalPaidAmount = paid_amount !== undefined ? paid_amount : paid;
      const finalEppBalance = epp_balance !== undefined ? epp_balance : epp;

      // Validate dates if provided
      if (statement_date) {
        const stmtDate = new Date(statement_date);
        if (isNaN(stmtDate.getTime())) {
          return res.status(400).json({
            success: false,
            error: 'Invalid statement_date format. Expected YYYY-MM-DD'
          });
        }
      }

      if (due_date) {
        const dueDate = new Date(due_date);
        if (isNaN(dueDate.getTime())) {
          return res.status(400).json({
            success: false,
            error: 'Invalid due_date format. Expected YYYY-MM-DD'
          });
        }
      }

      // Validate numeric fields if provided (using normalized values)
      if (finalTotalDue !== undefined) {
        const total = parseFloat(finalTotalDue);
        if (isNaN(total) || total < 0) {
          return res.status(400).json({
            success: false,
            error: 'total_due/total_payment_due must be a valid number >= 0'
          });
        }
      }

      if (finalPaidAmount !== undefined) {
        const paid = parseFloat(finalPaidAmount);
        if (isNaN(paid) || paid < 0) {
          return res.status(400).json({
            success: false,
            error: 'paid_amount/paid must be a valid number >= 0'
          });
        }
      }

      if (finalEppBalance !== undefined) {
        const epp = parseFloat(finalEppBalance);
        if (isNaN(epp) || epp < 0) {
          return res.status(400).json({
            success: false,
            error: 'epp_balance/epp must be a valid number >= 0'
          });
        }
      }

      if (balance_transfer !== undefined) {
        const bt = parseFloat(balance_transfer);
        if (isNaN(bt) || bt < 0) {
          return res.status(400).json({
            success: false,
            error: 'balance_transfer must be a valid number >= 0'
          });
        }
      }

      // Get existing statement - support both statement_id and card_id + month
      let existingStatement = null;
      let statementId = id; // Default to treating id as statement_id
      
      if (month) {
        // If month is provided, treat id as card_id
        existingStatement = await Statement.getByCardIdAndMonth(id, month);
        if (existingStatement) {
          statementId = existingStatement.id; // Use the actual statement_id for update
        }
      } else {
        // Otherwise, treat id as statement_id
        existingStatement = await Statement.getById(id);
      }
      
      // If statement doesn't exist but card_id + month provided, auto-create it
      if (!existingStatement && month) {
        // Verify card exists
        const card = await Card.getById(id);
        if (!card) {
          return res.status(404).json({
            success: false,
            error: 'Card not found'
          });
        }
        
        // Get card's billing_cycle_days and statement_day
        const billingCycleDays = card.billing_cycle_days || 25;
        const statementDay = card.statement_day || 1;
        
        // Calculate statement_date and due_date
        const [year, monthNum] = month.split('-');
        const yearNum = parseInt(year);
        const monthNumInt = parseInt(monthNum);
        const daysInMonth = new Date(yearNum, monthNumInt, 0).getDate();
        const finalStatementDay = Math.min(statementDay, daysInMonth);
        const dayStr = String(finalStatementDay).padStart(2, '0');
        const monthStr = String(monthNumInt).padStart(2, '0');
        const defaultStatementDate = `${yearNum}-${monthStr}-${dayStr}`;
        
        // Calculate due_date
        const stmtDate = new Date(defaultStatementDate + 'T12:00:00');
        stmtDate.setDate(stmtDate.getDate() + billingCycleDays);
        const dueYear = stmtDate.getFullYear();
        const dueMonth = String(stmtDate.getMonth() + 1).padStart(2, '0');
        const dueDay = String(stmtDate.getDate()).padStart(2, '0');
        const defaultDueDate = `${dueYear}-${dueMonth}-${dueDay}`;
        
        // Format due_month
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                           'July', 'August', 'September', 'October', 'November', 'December'];
        const dueMonthStr = `${monthNames[parseInt(dueMonth) - 1]} ${dueYear}`;
        
        // Use provided dates if available, otherwise use calculated defaults
        const finalStatementDate = statement_date || defaultStatementDate;
        const finalDueDate = due_date || defaultDueDate;
        
        // Calculate initial values
        const initTotalDue = finalTotalDue !== undefined ? parseFloat(finalTotalDue) : 0;
        const initPaidAmount = finalPaidAmount !== undefined ? parseFloat(finalPaidAmount) : 0;
        const initEppBalance = finalEppBalance !== undefined ? parseFloat(finalEppBalance) : 0;
        
        // Calculate pending_amount
        const initPendingAmount = StatementService.calculatePendingAmount(initTotalDue, initPaidAmount, initEppBalance);
        
        // Calculate payment_status
        const initPaymentStatus = StatementService.calculatePaymentStatus(initPendingAmount, finalDueDate);
        
        // Create new statement
        const newStatement = await Statement.create({
          creditCardId: id,
          statementMonth: month,
          statementDate: finalStatementDate,
          dueDate: finalDueDate,
          days: billingCycleDays,
          dueMonth: due_month || dueMonthStr,
          totalDue: initTotalDue,
          paidAmount: initPaidAmount,
          eppBalance: initEppBalance,
          balanceTransfer: balance_transfer !== undefined ? parseFloat(balance_transfer) : 0,
          pendingAmount: initPendingAmount,
          paymentStatus: initPaymentStatus
        });
        
        existingStatement = newStatement;
        statementId = newStatement.id;
      } else if (!existingStatement) {
        // Statement not found and no month provided (using statement_id)
        return res.status(404).json({
          success: false,
          error: 'Statement not found'
        });
      } else {
        // Use the actual statement_id for updates
        statementId = existingStatement.id;
      }

      // Calculate final values for validation (use normalized provided values or existing)
      // Note: existingStatement is guaranteed to exist at this point (either found or auto-created)
      const validationTotalDue = finalTotalDue !== undefined ? parseFloat(finalTotalDue) : parseFloat(existingStatement.total_due || 0);
      const validationPaidAmount = finalPaidAmount !== undefined ? parseFloat(finalPaidAmount) : parseFloat(existingStatement.paid_amount || 0);
      const validationEppBalance = finalEppBalance !== undefined ? parseFloat(finalEppBalance) : parseFloat(existingStatement.epp_balance || 0);

      // Validate that paid_amount + epp_balance doesn't exceed total_due
      if (validationPaidAmount + validationEppBalance > validationTotalDue) {
        return res.status(400).json({
          success: false,
          error: `Paid amount (${validationPaidAmount}) + EPP (${validationEppBalance}) cannot exceed Total Payment Due (${validationTotalDue})`
        });
      }

      // Build update data using normalized field names
      const updateData = {};
      if (statement_date !== undefined) updateData.statement_date = statement_date;
      if (due_date !== undefined) updateData.due_date = due_date;
      if (due_month !== undefined) updateData.due_month = due_month;
      if (finalTotalDue !== undefined) updateData.total_due = finalTotalDue;
      if (finalPaidAmount !== undefined) updateData.paid_amount = finalPaidAmount;
      if (finalEppBalance !== undefined) updateData.epp_balance = finalEppBalance;
      if (balance_transfer !== undefined) updateData.balance_transfer = balance_transfer;

      const statement = await StatementService.updateStatement(statementId, updateData);

      // Format amounts and dates for display
      let formattedDueMonth = statement.due_month;
      if (!formattedDueMonth || (typeof formattedDueMonth === 'number')) {
        formattedDueMonth = statement.due_date ? getMonthAbbreviation(statement.due_date) : null;
      } else if (typeof formattedDueMonth === 'string' && formattedDueMonth.length > 3) {
        // Convert full month name to abbreviation
        const monthNamesFull = ['January', 'February', 'March', 'April', 'May', 'June', 
                               'July', 'August', 'September', 'October', 'November', 'December'];
        const monthNamesShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const monthIndex = monthNamesFull.findIndex(m => formattedDueMonth.includes(m));
        formattedDueMonth = monthIndex !== -1 ? monthNamesShort[monthIndex] : (statement.due_date ? getMonthAbbreviation(statement.due_date) : null);
      }

      const formattedStatement = {
        // Card details
        issuing_bank: statement.issuing_bank,
        card_holder: statement.card_holder,
        card_number: statement.card_number,
        
        // IDs
        id: statement.id, // statement_id
        card_id: statement.card_id || statement.credit_card_id, // Always present
        credit_card_id: statement.credit_card_id,
        statement_id: statement.id, // Same as id (for clarity)
        
        // Statement details
        statement_month: statement.statement_month,
        statement_date: formatDateDDMMYY(statement.statement_date),
        due_date: formatDateDDMMYY(statement.due_date),
        days: statement.days,
        due_month: formattedDueMonth,
        total_payment_due: formatAmount(statement.total_due),
        paid: formatAmount(statement.paid_amount),
        epp: formatAmount(statement.epp_balance),
        amount_pending: formatAmount(statement.pending_amount),
        balance_transfer: formatAmount(statement.balance_transfer),
        payment_status: statement.payment_status,
        created_at: statement.created_at,
        updated_at: statement.updated_at
      };

      res.json({
        success: true,
        message: 'Statement updated successfully',
        data: formattedStatement
      });
    } catch (error) {
      console.error('Error updating statement:', error);
      
      if (error.message.includes('not found')) {
        return res.status(404).json({
          success: false,
          error: error.message
        });
      }

      if (error.message.includes('must be >= 0')) {
        return res.status(400).json({
          success: false,
          error: error.message
        });
      }

      res.status(500).json({
        success: false,
        error: error.message || 'Failed to update statement'
      });
    }
  }

  // GET /api/statements/detail/:id - Get single statement
  // Can pass statement_id directly, or use card_id + month query params
  // Examples:
  //   GET /api/statements/detail/statement-uuid
  //   GET /api/statements/detail/card-uuid?month=2026-01
  static async getStatement(req, res) {
    try {
      const { id } = req.params;
      const { month } = req.query;

      let statement = null;
      let card = null;

      // If month query param is provided, treat id as card_id
      if (month) {
        statement = await Statement.getByCardIdAndMonth(id, month);
        // If statement doesn't exist, fetch card to calculate default values
        if (!statement) {
          card = await Card.getById(id);
          if (!card) {
            return res.status(404).json({
              success: false,
              error: 'Card not found'
            });
          }
        }
      } else {
        // Otherwise, treat id as statement_id
        statement = await Statement.getById(id);
        if (!statement) {
          return res.status(404).json({
            success: false,
            error: 'Statement not found'
          });
        }
      }

      // If statement doesn't exist but card exists, calculate default values
      if (!statement && card && month) {
        // Parse month to get year and month number
        const [year, monthNum] = month.split('-');
        const yearNum = parseInt(year);
        const monthNumInt = parseInt(monthNum);
        
        // Use card's statement_day (default to 1 if not set)
        const statementDay = card.statement_day ? parseInt(card.statement_day) : 1;
        
        // Calculate statement_date
        const daysInMonth = new Date(yearNum, monthNumInt, 0).getDate();
        const finalStatementDay = Math.min(statementDay, daysInMonth);
        const dayStr = String(finalStatementDay).padStart(2, '0');
        const monthStr = String(monthNumInt).padStart(2, '0');
        const defaultStatementDate = `${yearNum}-${monthStr}-${dayStr}`;
        
        // Calculate due_date = statement_date + billing_cycle_days
        const billingCycleDays = card.billing_cycle_days || 25;
        const stmtDate = new Date(defaultStatementDate + 'T12:00:00');
        stmtDate.setDate(stmtDate.getDate() + billingCycleDays);
        const dueYear = stmtDate.getFullYear();
        const dueMonth = String(stmtDate.getMonth() + 1).padStart(2, '0');
        const dueDay = String(stmtDate.getDate()).padStart(2, '0');
        const defaultDueDate = `${dueYear}-${dueMonth}-${dueDay}`;
        
        // Create default statement object
        statement = {
          id: null,
          credit_card_id: card.id,
          card_id: card.id,
          statement_month: month,
          statement_date: defaultStatementDate,
          due_date: defaultDueDate,
          days: billingCycleDays,
          due_month: null, // Will be calculated below
          total_due: 0,
          paid_amount: 0,
          pending_amount: 0,
          epp_balance: 0,
          balance_transfer: 0,
          payment_status: 'PARTIAL',
          created_at: null,
          updated_at: null,
          issuing_bank: card.issuing_bank,
          card_holder: card.card_holder,
          card_number: card.card_number,
          expiry_date: card.expiry_date,
          credit_limit: card.credit_limit,
          is_active: card.is_active
        };
      }

      // Format amounts and dates for display
      let formattedDueMonth = statement.due_month;
      if (!formattedDueMonth || (typeof formattedDueMonth === 'number')) {
        formattedDueMonth = statement.due_date ? getMonthAbbreviation(statement.due_date) : null;
      } else if (typeof formattedDueMonth === 'string' && formattedDueMonth.length > 3) {
        // Convert full month name to abbreviation
        const monthNamesFull = ['January', 'February', 'March', 'April', 'May', 'June', 
                               'July', 'August', 'September', 'October', 'November', 'December'];
        const monthNamesShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const monthIndex = monthNamesFull.findIndex(m => formattedDueMonth.includes(m));
        formattedDueMonth = monthIndex !== -1 ? monthNamesShort[monthIndex] : (statement.due_date ? getMonthAbbreviation(statement.due_date) : null);
      }

      const formattedStatement = {
        // Card details
        issuing_bank: statement.issuing_bank,
        card_holder: statement.card_holder,
        card_number: statement.card_number,
        
        // IDs
        id: statement.id, // statement_id
        card_id: statement.card_id || statement.credit_card_id, // Always present
        credit_card_id: statement.credit_card_id,
        statement_id: statement.id, // Same as id (for clarity)
        
        // Statement details
        statement_month: statement.statement_month,
        statement_date: formatDateDDMMYY(statement.statement_date),
        due_date: formatDateDDMMYY(statement.due_date),
        days: statement.days,
        due_month: formattedDueMonth,
        total_payment_due: formatAmount(statement.total_due),
        paid: formatAmount(statement.paid_amount),
        epp: formatAmount(statement.epp_balance),
        amount_pending: formatAmount(statement.pending_amount),
        balance_transfer: formatAmount(statement.balance_transfer),
        payment_status: statement.payment_status,
        created_at: statement.created_at,
        updated_at: statement.updated_at
      };

      res.json({
        success: true,
        data: formattedStatement
      });
    } catch (error) {
      console.error('Error fetching statement:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch statement'
      });
    }
  }
}

module.exports = StatementController;
