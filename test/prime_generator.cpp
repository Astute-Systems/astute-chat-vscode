#include <iostream>
#include <cmath>
#include <vector>

/**
 * @brief Checks if a given number is prime.
 * @param n The number to check.
 * @return true if n is prime, false otherwise.
 */
bool isPrime(long long n) {
    if (n <= 1) return false;
    if (n <= 3) return true;
    if (n % 2 == 0 || n % 3 == 0) return false;
    for (long long i = 5; i * i <= n; i = i + 6) {
        if (n % i == 0 || n % (i + 2) == 0) return false;
    }
    return true;
}

/**
 * @brief Generates a list of prime numbers up to a given limit using the Sieve of Eratosthenes.
 * @param limit The upper bound for prime generation.
 * @return A vector of prime numbers.
 */
std::vector<long long> generatePrimes(long long limit) {
    std::vector<bool> is_prime(limit + 1, true);
    is_prime[0] = is_prime[1] = false;

    for (long long p = 2; p * p <= limit; p++) {
        if (is_prime[p]) {
            for (long long i = p * p; i <= limit; i += p)
                is_prime[i] = false;
        }
    }

    std::vector<long long> primes;
    for (long long p = 2; p <= limit; p++) {
        if (is_prime[p]) {
            primes.push_back(p);
        }
    }
    return primes;
}

int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::cerr << "Usage: " << argv[0] << " <limit>" << std::endl;
        return 1;
    }

    long long limit;
    try {
        limit = std::stoll(argv[1]);
    } catch (const std::exception& e) {
        std::cerr << "Error: Invalid limit provided." << std::endl;
        return 1;
    }

    if (limit < 0) {
        std::cerr << "Error: Limit must be non-negative." << std::endl;
        return 1;
    }

    std::cout << "--- Prime Number Generator ---" << std::endl;

    // Test single number check
    long long test_num = 101;
    if (isPrime(test_num)) {
        std::cout << test_num << " is prime." << std::endl;
    } else {
        std::cout << test_num << " is not prime." << std::endl;
    }

    // Generate primes up to limit
    std::vector<long long> primes = generatePrimes(limit);

    std::cout << "\nPrimes up to " << limit << " (" << primes.size() << " found):" << std::endl;
    for (size_t i = 0; i < primes.size(); ++i) {
        std::cout << primes[i] << (i == primes.size() - 1 ? "" : ", ");
    }
    std::cout << std::endl;

    return 0;
}