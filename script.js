// Loading animation script
window.addEventListener('load', () => {
    const loader = document.getElementById('loader');
    const content = document.getElementById('content');
    loader.classList.add('hidden');
    content.classList.remove('hidden');
});

// MetaMask integration script
const connectButton = document.getElementById('connectButton');

connectButton.addEventListener('click', async () => {
    if (typeof window.ethereum !== 'undefined') {
        try {
            const accounts = await ethereum.request({ method: 'eth_requestAccounts' });
            alert(`Connected: ${accounts[0]}`);
        } catch (error) {
            console.error('User rejected the request.');
        }
    } else {
        alert('Please install MetaMask to use this feature.');
    }
});