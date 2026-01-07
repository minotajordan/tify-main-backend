const express = require('express');
const router = express.Router();
const { COUNTRIES, STATES, CITIES } = require('../data/locationData');

router.get('/countries', (req, res) => {
  res.json(COUNTRIES);
});

router.get('/states/:countryCode', (req, res) => {
  const { countryCode } = req.params;
  const states = STATES[countryCode] || [];
  res.json(states);
});

router.get('/cities/:stateCode', (req, res) => {
  const { stateCode } = req.params;
  const cities = CITIES[stateCode] || [];
  res.json(cities);
});

module.exports = router;
