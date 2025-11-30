// app.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const AMADEUS_CLIENT_ID = process.env.AMADEUS_CLIENT_ID;
const AMADEUS_CLIENT_SECRET = process.env.AMADEUS_CLIENT_SECRET;

// Function to get OAuth access token from Amadeus
async function getAccessToken() {
  const response = await axios.post(
    'https://test.api.amadeus.com/v1/security/oauth2/token',
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: AMADEUS_CLIENT_ID,
      client_secret: AMADEUS_CLIENT_SECRET,
    }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );
  return response.data.access_token;
}

// Endpoint that GPT will call
app.post('/search_flights', async (req, res) => {
  try {
    const {
      origin,
      destination,
      departureDate,
      adults = 1,
      currency = 'KWD',
      max = 5,
    } = req.body;

    if (!origin || !destination || !departureDate) {
      return res
        .status(400)
        .json({ error: 'origin, destination, and departureDate are required' });
    }

    const token = await getAccessToken();

    const amadeusResponse = await axios.get(
      'https://test.api.amadeus.com/v2/shopping/flight-offers',
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        params: {
          originLocationCode: origin,
          destinationLocationCode: destination,
          departureDate,
          adults,
          currencyCode: currency,
          max,
        },
      }
    );

    const offers = amadeusResponse.data.data || [];

    // Simplify the response
    const options = offers.map((offer) => {
      const price = offer.price.total;
      const currencyCode = offer.price.currency;
      const firstItinerary = offer.itineraries[0];
      const duration = firstItinerary.duration;
      const segments = firstItinerary.segments;

      return {
        id: offer.id,
        price: parseFloat(price),
        currency: currencyCode,
        duration,
        airline: segments[0]?.carrierCode,
        segments: segments.map((s) => ({
          from: s.departure.iataCode,
          to: s.arrival.iataCode,
          departureTime: s.departure.at,
          arrivalTime: s.arrival.at,
          carrier: s.carrierCode,
          flightNumber: s.number,
        })),
      };
    });

    res.json({ options });
  } catch (error) {
    console.error(
      'Error searching flights:',
      error.response?.data || error.message
    );
    res.status(500).json({
      error: 'Failed to search flights',
      details: error.response?.data || error.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
