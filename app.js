// app.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const AMADEUS_CLIENT_ID = process.env.AMADEUS_CLIENT_ID;
const AMADEUS_CLIENT_SECRET = process.env.AMADEUS_CLIENT_SECRET;

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

// Helper to map a single Amadeus offer into our simplified format
// Helper to map a single Amadeus offer into our simplified format
function mapOfferToOption(offer) {
  const price = offer.price.total;
  const currencyCode = offer.price.currency;
  const firstItinerary = offer.itineraries[0];
  const duration = firstItinerary.duration;
  const segments = firstItinerary.segments;

  // Try to extract cabin class (ECONOMY, BUSINESS, etc.)
  let cabinClass = null;
  let checkedBags = null;
  let fareBasis = null;
  let brandedFare = null;

  try {
    const firstTraveler = offer.travelerPricings?.[0];
    const firstFareDetail = firstTraveler?.fareDetailsBySegment?.[0];

    cabinClass = firstFareDetail?.cabin || null;

    // Included checked bags (e.g. 1, 2)
    if (firstFareDetail?.includedCheckedBags) {
      if (typeof firstFareDetail.includedCheckedBags.quantity === 'number') {
        checkedBags = firstFareDetail.includedCheckedBags.quantity;
      }
    }

    // Fare info (helps GPT talk about flexibility)
    fareBasis = firstFareDetail?.fareBasis || null;
    // e.g. "SAVER", "FLEX" – depends on airline
    brandedFare = firstFareDetail?.brandedFare || null;
  } catch (err) {
    cabinClass = cabinClass || null;
    checkedBags = checkedBags || null;
    fareBasis = fareBasis || null;
    brandedFare = brandedFare || null;
  }

  return {
    id: offer.id,
    price: parseFloat(price),
    currency: currencyCode,
    duration,
    airline: segments[0]?.carrierCode,
    cabin: cabinClass,         // ⬅ seat class
    checkedBags,               // ⬅ number of checked bags included (if known)
    fareBasis,                 // ⬅ fare basis code
    brandedFare,               // ⬅ fare family name (e.g., saver/flex)
    segments: segments.map((s) => ({
      from: s.departure.iataCode,
      to: s.arrival.iataCode,
      departureTime: s.departure.at,
      arrivalTime: s.arrival.at,
      carrier: s.carrierCode,
      flightNumber: s.number,
    })),
  };
}

// Main endpoint GPT will call
app.post('/search_flights', async (req, res) => {
  try {
    const {
      tripType = 'oneway',        // 'oneway' | 'roundtrip' | 'multi'
      origin,
      destination,
      departureDate,
      returnDate,                 // used for roundtrip
      segments,                   // used for multi
      adults = 1,
      currency = 'KWD',
      max = 5,
      maxPrice                    // optional budget filter
    } = req.body;

    const token = await getAccessToken();
    const url = 'https://test.api.amadeus.com/v2/shopping/flight-offers';

    // ---------- ONE-WAY & ROUNDTRIP ----------
    if (tripType === 'oneway' || tripType === 'roundtrip') {
      if (!origin || !destination || !departureDate) {
        return res
          .status(400)
          .json({ error: 'origin, destination, and departureDate are required' });
      }

      const params = {
        originLocationCode: origin,
        destinationLocationCode: destination,
        departureDate,
        adults,
        currencyCode: currency,
        max
      };

      // Roundtrip support (single Amadeus call with returnDate)
      if (tripType === 'roundtrip') {
        if (!returnDate) {
          return res
            .status(400)
            .json({ error: 'returnDate is required for roundtrip searches' });
        }
        params.returnDate = returnDate;
      }

      // Budget filter (Amadeus side)
      if (maxPrice) {
        params.maxPrice = maxPrice;
      }

      const amadeusResponse = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        params
      });

      let offers = amadeusResponse.data.data || [];
      let options = offers.map(mapOfferToOption);

      // Extra budget filter (our side)
      if (maxPrice) {
        options = options.filter((opt) => opt.price <= maxPrice);
      }

      return res.json({
        tripType,
        origin,
        destination,
        departureDate,
        returnDate: tripType === 'roundtrip' ? returnDate : undefined,
        options
      });
    }

    // ---------- MULTI-CITY ----------
    if (tripType === 'multi') {
      // segments = [{ origin, destination, date }, ...]
      if (!Array.isArray(segments) || segments.length === 0) {
        return res
          .status(400)
          .json({ error: 'segments array is required for multi-city searches' });
      }

      const legs = [];

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (!seg.origin || !seg.destination || !seg.date) {
          return res.status(400).json({
            error:
              'Each segment must include origin, destination, and date (YYYY-MM-DD)'
          });
        }

        const params = {
          originLocationCode: seg.origin,
          destinationLocationCode: seg.destination,
          departureDate: seg.date,
          adults,
          currencyCode: currency,
          max
        };

        if (maxPrice) {
          params.maxPrice = maxPrice;
        }

        const legRes = await axios.get(url, {
          headers: { Authorization: `Bearer ${token}` },
          params
        });

        let legOffers = legRes.data.data || [];
        let legOptions = legOffers.map(mapOfferToOption);

        if (maxPrice) {
          legOptions = legOptions.filter((opt) => opt.price <= maxPrice);
        }

        legs.push({
          legIndex: i + 1,
          origin: seg.origin,
          destination: seg.destination,
          date: seg.date,
          options: legOptions
        });
      }

      return res.json({
        tripType: 'multi',
        adults,
        currency,
        max,
        maxPrice: maxPrice || undefined,
        legs
      });
    }

    // If tripType is something else
    return res.status(400).json({
      error: "tripType must be 'oneway', 'roundtrip', or 'multi'"
    });
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
