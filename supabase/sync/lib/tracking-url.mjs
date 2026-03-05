/**
 * Build the correct tracking URL based on carrier and tracking number.
 */
export function buildTrackingUrl(trackingNumber, carrierName) {
    if (!trackingNumber) return null;
    const tn = trackingNumber.trim();
    const carrier = (carrierName || '').toLowerCase();

    // UPS: 1Z...
    if (tn.startsWith('1Z') || carrier.includes('ups')) {
        return `https://www.ups.com/track?track=yes&trackNums=${tn}`;
    }

    // FedEx: 12-22 digit numbers
    if (carrier.includes('fedex') || /^\d{12,22}$/.test(tn)) {
        return `https://www.fedex.com/fedextrack/?trknbr=${tn}`;
    }

    // USPS: starts with 9, 20-34 digits
    if (carrier.includes('usps') || carrier.includes('stamps') || /^9\d{19,33}$/.test(tn)) {
        return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${tn}`;
    }

    // OnTrac: starts with C or D
    if (carrier.includes('ontrac') || /^[CD]\d{10,20}$/.test(tn)) {
        return `https://www.ontrac.com/tracking/?number=${tn}`;
    }

    // Amazon TBA
    if (tn.startsWith('TBA')) {
        return `https://track.amazon.com/tracking/${tn}`;
    }

    // Default: AfterShip (works for Buy Shipping / unknown carriers)
    return `https://aftership.com/track/${tn}`;
}
