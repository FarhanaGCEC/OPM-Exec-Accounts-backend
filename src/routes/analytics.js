const express = require('express');
const { pool } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { formatAmount } = require('../utils/formatAmount');

const router = express.Router();

// Get debit/credit analytics for charts
router.get('/transactions', authenticateToken, async (req, res) => {
  try {
    const { period = 'monthly', startDate, endDate } = req.query;

    let dateFormat, groupBy;
    if (period === 'daily') {
      dateFormat = 'YYYY-MM-DD';
      groupBy = 'DATE(t.date)';
    } else if (period === 'weekly') {
      dateFormat = 'YYYY-"W"WW';
      groupBy = 'DATE_TRUNC(\'week\', t.date)';
    } else {
      // monthly (default)
      dateFormat = 'YYYY-MM';
      groupBy = 'DATE_TRUNC(\'month\', t.date)';
    }

    let dateFilter = '';
    const params = [];
    if (startDate && endDate) {
      dateFilter = 'WHERE t.date >= $1 AND t.date <= $2';
      params.push(startDate, endDate);
    }

    // Get debit and credit totals grouped by period
    const query = `
      SELECT 
        TO_CHAR(${groupBy}, '${dateFormat}') as period,
        t.type,
        SUM(t.amount) as total_amount,
        COUNT(*) as transaction_count
      FROM transactions t
      ${dateFilter}
      GROUP BY ${groupBy}, t.type
      ORDER BY ${groupBy} DESC, t.type
    `;

    const result = await pool.query(query, params.length > 0 ? params : []);

    // Format data for charts
    const formattedData = {
      labels: [],
      datasets: [
        {
          label: 'Debit',
          data: [],
          backgroundColor: 'rgba(239, 68, 68, 0.8)', // Red for debit
          borderColor: 'rgba(239, 68, 68, 1)',
          borderWidth: 1
        },
        {
          label: 'Credit',
          data: [],
          backgroundColor: 'rgba(34, 197, 94, 0.8)', // Green for credit
          borderColor: 'rgba(34, 197, 94, 1)',
          borderWidth: 1
        }
      ]
    };

    // Group by period
    const periodData = {};
    result.rows.forEach(row => {
      if (!periodData[row.period]) {
        periodData[row.period] = { Debit: 0, Credit: 0 };
      }
      periodData[row.period][row.type] = parseFloat(row.total_amount);
    });

    // Sort periods and populate chart data
    const sortedPeriods = Object.keys(periodData).sort();
    sortedPeriods.forEach(period => {
      formattedData.labels.push(period);
      formattedData.datasets[0].data.push(formatAmount(periodData[period].Debit || 0));
      formattedData.datasets[1].data.push(formatAmount(periodData[period].Credit || 0));
    });

    const totalDebit = result.rows.filter(r => r.type === 'Debit').reduce((sum, r) => sum + parseFloat(r.total_amount), 0);
    const totalCredit = result.rows.filter(r => r.type === 'Credit').reduce((sum, r) => sum + parseFloat(r.total_amount), 0);

    res.json({
      success: true,
      period: period,
      data: formattedData,
      summary: {
        totalDebit: formatAmount(totalDebit),
        totalCredit: formatAmount(totalCredit),
        totalTransactions: result.rows.reduce((sum, r) => sum + parseInt(r.transaction_count), 0)
      }
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch transaction analytics'
    });
  }
});

// Get monthly summary (simplified for bar charts)
router.get('/monthly-summary', authenticateToken, async (req, res) => {
  try {
    const { year = new Date().getFullYear() } = req.query;

    const query = `
      SELECT 
        TO_CHAR(DATE_TRUNC('month', t.date), 'Mon YYYY') as month,
        TO_CHAR(DATE_TRUNC('month', t.date), 'YYYY-MM') as month_sort,
        t.type,
        SUM(t.amount) as total_amount,
        COUNT(*) as count
      FROM transactions t
      WHERE EXTRACT(YEAR FROM t.date) = $1
      GROUP BY DATE_TRUNC('month', t.date), t.type
      ORDER BY DATE_TRUNC('month', t.date) ASC, t.type
    `;

    const result = await pool.query(query, [year]);

    // Format for chart
    const monthlyData = {};
    result.rows.forEach(row => {
      if (!monthlyData[row.month_sort]) {
        monthlyData[row.month_sort] = {
          month: row.month,
          Debit: 0,
          Credit: 0
        };
      }
      monthlyData[row.month_sort][row.type] = parseFloat(row.total_amount);
    });

    const chartData = {
      labels: [],
      debit: [],
      credit: []
    };

    Object.keys(monthlyData).sort().forEach(key => {
      chartData.labels.push(monthlyData[key].month);
      chartData.debit.push(formatAmount(monthlyData[key].Debit));
      chartData.credit.push(formatAmount(monthlyData[key].Credit));
    });

    res.json({
      success: true,
      year: parseInt(year),
      data: chartData,
      raw: monthlyData
    });
  } catch (error) {
    console.error('Error fetching monthly summary:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch monthly summary'
    });
  }
});

// Get category-wise summary
router.get('/category-summary', authenticateToken, async (req, res) => {
  try {
    const { type, startDate, endDate } = req.query;

    let dateFilter = '';
    const params = [];
    let paramIndex = 1;

    if (startDate && endDate) {
      dateFilter = `WHERE t.date >= $${paramIndex} AND t.date <= $${paramIndex + 1}`;
      params.push(startDate, endDate);
      paramIndex += 2;
    }

    if (type) {
      dateFilter += dateFilter ? ' AND' : 'WHERE';
      dateFilter += ` t.type = $${paramIndex}`;
      params.push(type);
    }

    const query = `
      SELECT 
        COALESCE(pc.name, rc.name, 'Uncategorized') as category_name,
        t.type,
        SUM(t.amount) as total_amount,
        COUNT(*) as transaction_count
      FROM transactions t
      LEFT JOIN payables_categories pc ON t.category_id = pc.id AND t.category_type = 'payable'
      LEFT JOIN receivables_categories rc ON t.category_id = rc.id AND t.category_type = 'receivable'
      ${dateFilter}
      GROUP BY COALESCE(pc.name, rc.name), t.type
      ORDER BY total_amount DESC
    `;

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows.map(row => ({
        category: row.category_name,
        type: row.type,
        totalAmount: formatAmount(row.total_amount),
        transactionCount: parseInt(row.transaction_count)
      }))
    });
  } catch (error) {
    console.error('Error fetching category summary:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch category summary'
    });
  }
});

// Get balance trend over time
router.get('/balance-trend', authenticateToken, async (req, res) => {
  try {
    const { period = 'monthly', limit = 12 } = req.query;

    let groupBy;
    if (period === 'daily') {
      groupBy = 'DATE(t.date)';
    } else if (period === 'weekly') {
      groupBy = 'DATE_TRUNC(\'week\', t.date)';
    } else {
      groupBy = 'DATE_TRUNC(\'month\', t.date)';
    }

    const query = `
      SELECT 
        ${groupBy} as period,
        MAX(t.balance) as closing_balance,
        MIN(t.balance) as opening_balance,
        COUNT(*) as transaction_count
      FROM transactions t
      GROUP BY ${groupBy}
      ORDER BY ${groupBy} DESC
      LIMIT $1
    `;

    const result = await pool.query(query, [parseInt(limit)]);

    const trendData = {
      labels: [],
      balances: [],
      openingBalances: [],
      closingBalances: []
    };

    result.rows.reverse().forEach(row => {
      const date = new Date(row.period);
      let label;
      if (period === 'daily') {
        label = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
      } else if (period === 'weekly') {
        const weekNum = Math.ceil((date.getDate() - date.getDay()) / 7);
        label = `Week ${weekNum}`;
      } else {
        label = date.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
      }

      trendData.labels.push(label);
      trendData.balances.push(formatAmount(row.closing_balance));
      trendData.openingBalances.push(formatAmount(row.opening_balance));
      trendData.closingBalances.push(formatAmount(row.closing_balance));
    });

    res.json({
      success: true,
      period: period,
      data: trendData
    });
  } catch (error) {
    console.error('Error fetching balance trend:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch balance trend'
    });
  }
});

module.exports = router;

