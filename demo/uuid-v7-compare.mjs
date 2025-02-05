import { v7 as uuidv7, version as uuidVersion, validate as uuidValidate } from 'uuid';

function uuidValidateV7(uuid) {
    return uuidValidate(uuid) && uuidVersion(uuid) === 7;
}

// Generate two UUIDs with a small delay between them
const uuid1 = uuidv7();
// Add a small delay to ensure different timestamps
setTimeout(() => {
    const uuid2 = uuidv7();

    if (!uuidValidateV7(uuid1) || !uuidValidateV7(uuid2)) {
        console.error('Invalid UUIDs');
        return;
    }

    const timestamp1 = parseInt(uuid1.replace(/-/g, '').slice(0, 12), 16);
    const timestamp2 = new Date().getTime();
    const diffMs = timestamp2 - timestamp1;

    if (uuid1 < uuid2) {
        console.log(`UUID 2 was created ${diffMs}ms after UUID 1`);
    } else {
        console.log(`UUID 1 was created ${diffMs}ms after UUID 2`);
    }

    console.log('UUID 1:', uuid1);
    console.log('UUID 2:', uuid2);
}, 100);

