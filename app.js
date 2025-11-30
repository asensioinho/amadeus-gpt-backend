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

/* ---------------------------------------------------------
   MAP OFFER → OUR FORMAT (Corrected & Complete)
--------------------------------------------------------- */
function mapOfferToOption(offer) {
  const firstItinerary = offer.itineraries[0];
  const segments = firstItinerary.segments;

  const traveler = offer.travelerPricings?.[0] || {};
  const fareDetails = traveler.fareDetailsBySegment || [];

  const segmentFareMap = {};
  fareDetails.forEach((fd) => {
    const segId = fd.segmentId;
    segmentFareMap[segId] = {
      cabin: fd.cabin || null,
      class: fd.class || null,
      brandedFare: fd.brandedFare || null,
      fareBasis: fd.fareBasis || null,
      checkedBags: fd.includedCheckedBags?.quantity ?? null,
    };
  });

  const fallbackFare = {
    cabin: null,
    class: null,
    brandedFare: null,
    fareBasis: null,
    checkedBags: null,
  };

  return {
    id: offer.id,
    price: parseFloat(offer.price.total),
    currency: offer.price.currency,
    duration: firstItinerary.duration,
    airline: segments[0]?.carrierCode,

    // Overall cabin/baggage taken from first segment
    cabin: segmentFareMap[segments[0].id]?.cabin ?? null,
    brandedFare: segmentFareMap[segments[0].id]?.brandedFare ?? null,
    fareBasis: segmentFareMap[segments[0].id]?.fareBasis ?? null,
    checkedBags: segmentFareMap[segments[0].id]?.checkedBags ?? null,

    segments: segments.map((s) => {
      const fareInfo = segmentFareMap[s.id] || fallbackFare;

      return {
        from: s.departure.iataCode,
        to: s.arrival.iataCode,
        departureTime: s.departure.at,
        arrivalTime: s.arrival.at,
        carrier: s.carrierCode,
        flightNumber: s.number,

        cabin: fareInfo.cabin,
        class: fareInfo.class,
        brandedFare: fareInfo.brandedFare,
        fareBasis: fareInfo.fareBasis,
        checkedBags: fareInfo.checkedBags,
      };
    }),
  };
}

/* ---------------------------------------------------------
   MAIN ENDPOINT
--------------------------------------------------------- */

app.post('/search_flights', async (req, res) => {
  try {
    const {
      tripType = 'oneway',
      origin,
      destination,
      departureDate,
      returnDate,
      segments,
      adults = 1,
      currency = 'KWD',
      max = 5,
      maxPrice,
      travelClass            // NEW!
    } = req.body;

    const token = await getAccessToken();
    const url = 'https://test.api.amadeus.com/v2/shopping/flight-offers';

    /* ---------------------------------------------------------
       ONE-WAY & ROUNDTRIP
    --------------------------------------------------------- */
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
        max,
      };

      if (tripType === 'roundtrip') {
        if (!returnDate) {
          return res
            .status(400)
            .json({ error: 'returnDate is required for roundtrip searches' });
        }
        params.returnDate = returnDate;
      }

      if (maxPrice) params.maxPrice = maxPrice;
      if (travelClass) params.travelClass = travelClass;

      const amadeusResponse = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        params,
      });

      let offers = amadeusResponse.data.data || [];
      let options = offers.map(mapOfferToOption);

      if (maxPrice) {
        options = options.filter((o) => o.price <= maxPrice);
      }

      return res.json({
        tripType,
        origin,
        destination,
        departureDate,
        returnDate: tripType === 'roundtrip' ? returnDate : undefined,
        options,
      });
    }

    /* ---------------------------------------------------------
       MULTI-CITY
    --------------------------------------------------------- */
    if (tripType === 'multi') {
      if (!Array.isArray(segments) || segments.length === 0) {
        return res.status(400).json({
          error: 'segments array is required for multi-city searches',
        });
      }

      const legs = [];

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];

        if (!seg.origin || !seg.destination || !seg.date) {
          return res.status(400).json({
            error:
              'Each segment must include origin, destination, and date (YYYY-MM-DD)',
          });
        }

        const params = {
          originLocationCode: seg.origin,
          destinationLocationCode: seg.destination,
          departureDate: seg.date,
          adults,
          currencyCode: currency,
          max,
        };

        if (maxPrice) params.maxPrice = maxPrice;
        if (travelClass) params.travelClass = travelClass;

        const legRes = await axios.get(url, {
          headers: { Authorization: `Bearer ${token}` },
          params,
        });

        let legOffers = legRes.data.data || [];
        let legOptions = legOffers.map(mapOfferToOption);

        if (maxPrice) {
          legOptions = legOptions.filter((o) => o.price <= maxPrice);
        }

        legs.push({
          legIndex: i + 1,
          origin: seg.origin,
          destination: seg.destination,
          date: seg.date,
          options: legOptions,
        });
      }

      return res.json({
        tripType: 'multi',
        adults,
        currency,
        max,
        maxPrice: maxPrice || undefined,
        legs,
      });
    }

    return res.status(400).json({
      error: "tripType must be 'oneway', 'roundtrip', or 'multi'",
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

/* ---------------------------------------------------------
   SERVER START
--------------------------------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
